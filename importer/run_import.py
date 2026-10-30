"""Daily job (GitHub Actions).

9 AM Cairo:  build today's schedule from the booking workbook - all white.
~2:45 PM:    read today's tab again so the schedule is current when Submit opens at 3 PM.
9 PM Cairo:  read today's tab again; the latest version is the final schedule.
12 midnight: a day stays open through the next day ("yesterday") so doctors have a full
             day to finish; when it stops being yesterday it is closed (doctors who did
             not submit keep what they marked).

The sheet link comes from private/source.shareUrl (the admin can change it on the site);
SHARE_URL is only the fallback. Each run records success/failure there for the admin.

Env: SHARE_URL, FIREBASE_API_KEY, FIREBASE_PROJECT, IMPORTER_EMAIL, IMPORTER_PASSWORD
     MODE=open|refresh|final|close to run outside the time windows, DAY=YYYY-MM-DD for another day.
"""
import datetime as dt
import http.cookiejar
import os
import re
import sys
import tempfile
import time
import urllib.request
from zoneinfo import ZoneInfo

from firestore_rest import Firestore, sign_in
from codes import treatments_of
from parse_day import parse_day

CAIRO = ZoneInfo("Africa/Cairo")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"


def _try_download(share_url):
    """One attempt, three ways (SharePoint sometimes leaves the download link out of the page)."""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [("User-Agent", UA)]
    token = share_url.split("?")[0].rstrip("/").rsplit("/", 1)[-1]
    tried = []
    resp = opener.open(share_url, timeout=120)
    final, page = resp.geturl(), resp.read().decode("utf-8", "replace")
    urls = []
    m = re.search(r'"FileGetUrl":"([^"]+)"', page)
    if m:
        urls.append(m.group(1).replace(r"\u0026", "&"))
    site = re.match(r"(https://[^/]+/personal/[^/]+)/", final)
    if site:
        g = re.search(r"sourcedoc=(?:%7B|\{)([0-9a-fA-F-]{36})", final)
        if g:
            urls.append("%s/_layouts/15/download.aspx?UniqueId=%s" % (site.group(1), g.group(1)))
        urls.append("%s/_layouts/15/download.aspx?share=%s" % (site.group(1), token))
    for url in urls:
        try:
            data = opener.open(url, timeout=300).read()
            if data[:2] == b"PK":
                return data
            tried.append("not xlsx")
        except Exception as e:
            tried.append(str(e)[:80])
    title = re.search(r"<title>([^<]*)", page)
    raise RuntimeError("could not download the sheet (page: %s, landed on %s, tried: %s)"
                       % (title.group(1).strip() if title else "?", final[:90], "; ".join(tried) or "no link found"))


def download_workbook(share_url, dest, attempts=3, wait=60):
    for i in range(attempts):
        try:
            data = _try_download(share_url)
            with open(dest, "wb") as f:
                f.write(data)
            return
        except Exception as e:
            print("download attempt %d failed: %s" % (i + 1, e))
            if i == attempts - 1:
                raise
            time.sleep(wait * (i + 1))


def summarize(day):
    out = {}
    for key, d in (day.get("doctors") or {}).items():
        ss = d.get("sessions", [])
        out[key] = {
            "name": d["name"],
            "section": d.get("section", ""),
            "sub": d.get("sub", ""),
            "submitted": bool(d.get("submitted")),
            "booked": sum(s.get("units", 1) for s in ss),
            "attended": sum(s.get("units", 1) for s in ss if s.get("status") == 1),
            "cases": sum(1 for s in ss if s.get("status") == 1),
            "noShow": sum(1 for s in ss if s.get("status") == 2),
            "unmarked": sum(1 for s in ss if not s.get("status")),
            "treat": treat_totals(s for s in ss if s.get("status") == 1),
            # the same day as the booking sheet shows it: red = cancelled, anything else = came
            "sheet": {
                "sessions": sum(s.get("units", 1) for s in ss if s.get("sheet") != "red"),
                "cases": sum(1 for s in ss if s.get("sheet") != "red"),
                "cancelled": sum(1 for s in ss if s.get("sheet") == "red"),
                "treat": treat_totals(s for s in ss if s.get("sheet") != "red"),
            },
        }
    return out


def treat_totals(sessions):
    out = {}
    for s in sessions:
        for t, n in treatments_of(s.get("details")).items():
            out[t] = out.get(t, 0) + n
    return out


def _sig(sess):
    return (sess["start"], sess["end"], re.sub(r"\s+", " ", sess["patient"]).strip())


def _who(sess):
    return (sess["start"], re.sub(r"\s+", " ", sess["patient"]).strip())


def merge_final(live, parsed):
    """3 PM / 9 PM: bring the day up to date with the sheet (9 PM = final).

    Marks are kept for every session that is still there (same time + patient).
    A doctor whose list of sessions did not change keeps their Submit; a doctor
    whose schedule changed is un-submitted (with a note) so they review it again.
    Returns (new doctors map, names of doctors whose schedule changed).
    """
    old_all = live.get("doctors") or {}
    # same column first; else same name + section (one doctor can have two columns, e.g.
    # Monica in Aqua and Lym); else the name alone when it is unique (column moved)
    by_ns = {(d["name"], d.get("section")): d for d in old_all.values()}
    names = [d["name"] for d in old_all.values()]
    by_name = {d["name"]: d for d in old_all.values() if names.count(d["name"]) == 1}
    doctors, changed = {}, []
    for d in parsed["doctors"]:
        old = old_all.get(d["key"])
        if old is None or old["name"] != d["name"]:
            old = by_ns.get((d["name"], d.get("section"))) or by_name.get(d["name"])
        if old:
            marks = {_who(x): x.get("status", 0) for x in old.get("sessions", [])}
            for x in d["sessions"]:
                x["status"] = marks.get(_who(x), 0)
            same = sorted(map(_sig, old.get("sessions", []))) == sorted(map(_sig, d["sessions"]))
            if same:
                for k in ("submitted", "submittedAt"):
                    if k in old:
                        d[k] = old[k]
            else:
                changed.append(d["name"])
                d["submitted"] = False
                if old.get("submitted"):                 # only they need to look again
                    d["changedAt"] = dt.datetime.now(CAIRO).isoformat()
        else:
            changed.append(d["name"])
        doctors[d["key"]] = d
    return doctors, changed


def _safe(fn):
    """The link/status record is a convenience - never let it stop an import."""
    try:
        return fn()
    except Exception as e:
        print("note: private/source not available (%s)" % str(e)[:120])
        return None


def remember_subs(db, doctors):
    """Some Saturday tabs don't show where Neuro ends and Ortho starts. Remember each doctor's usual
    group (private/subs) and use it for a doctor left without one."""
    memo = _safe(lambda: db.get("private/subs")) or {}
    counts = memo.get("counts", {})
    two_groups = any(d.get("sub") == "Ortho" for d in doctors) and any(d.get("sub") == "Neuro" for d in doctors)
    for d in doctors:
        if two_groups and d.get("sub"):         # learn only from days that clearly show both groups
            c = counts.setdefault(d["name"], {})
            c[d["sub"]] = c.get(d["sub"], 0) + 1
    # a day showing only one group (Fridays) can't tell Neuro from Ortho either: use the usual group
    one_group = not two_groups
    for d in doctors:
        known = counts.get(d["name"])
        if not known or d.get("section", "").lower() in ("inpatient", "ot", "lym"):
            continue
        if not d.get("sub") or one_group:
            d["sub"] = max(known, key=known.get)
    _safe(lambda: db.set("private/subs", {"counts": counts}))


def close_day(db, date, doc):
    db.set("stats/" + date, {"date": date, "doctors": summarize(doc), "autoClosed": True})
    db.update("days/" + date, {"status": "closed", "autoClosed": True,
                               "closedAt": dt.datetime.now(CAIRO).isoformat()})
    print("auto-closed", date)


def main():
    """Runs every hour; the Cairo hour decides what to do (or MODE=open|refresh|final|close):
       9 AM-8 PM: create today's schedule if it isn't there yet, else bring it up to date
                  with the sheet (once per hour) - a failed hour is simply redone next hour.
       9 PM:      last read of the sheet, the final schedule.
       midnight:  close every day older than yesterday."""
    now = dt.datetime.now(CAIRO)
    mode = os.environ.get("MODE")
    if not mode:
        mode = "close" if now.hour in (0, 1) else "hourly" if 9 <= now.hour <= 20 else "final" if now.hour in (21, 22) else None
    if not mode:
        print("nothing to do at %s Cairo" % now.strftime("%H:%M"))
        return
    day = dt.date.fromisoformat(os.environ["DAY"]) if os.environ.get("DAY") else now.date()
    date = day.isoformat()

    token = sign_in(os.environ["FIREBASE_API_KEY"], os.environ["IMPORTER_EMAIL"], os.environ["IMPORTER_PASSWORD"])
    db = Firestore(os.environ["FIREBASE_PROJECT"], token)

    # anything older than yesterday is closed (also checked at 9 AM in case midnight was missed)
    if mode in ("close", "open", "hourly"):
        keep_from = (now.date() - dt.timedelta(days=1)).isoformat()
        for d, doc in db.query_eq("days", "status", "open"):
            if d < keep_from:
                close_day(db, d, doc)
        if mode == "close":
            return
    live = db.get("days/" + date)
    if mode == "hourly":
        mode = "open" if live is None else "refresh"
    if mode == "open" and live is not None:
        print("days/%s already exists - skipping" % date)
        return
    done_key = {"refresh": "refreshedAt", "final": "finalAt"}.get(mode)
    if done_key and live and live.get(done_key) and not os.environ.get("MODE"):
        # final: once a day; refresh: once an hour (GitHub may start two runs in one hour)
        same = live[done_key][:13] == now.isoformat()[:13] if mode == "refresh" else True
        if same:
            print("%s for %s already done at %s - skipping" % (mode, date, live[done_key]))
            return

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "book.xlsx")
        src = _safe(lambda: db.get("private/source")) or {}
        url = src.get("shareUrl") or os.environ.get("SHARE_URL")
        try:
            download_workbook(url, path)
        except Exception as e:
            _safe(lambda: db.update("private/source", {"lastError": str(e)[:300], "lastErrorAt": dt.datetime.now(CAIRO).isoformat()}))
            raise
        _safe(lambda: db.update("private/source", {"lastOkAt": dt.datetime.now(CAIRO).isoformat(), "lastError": ""}))
        parsed = parse_day(path, day)
    if not parsed or not parsed["doctors"]:
        print("no tab for %s in the workbook - nothing imported" % day)
        return
    remember_subs(db, parsed["doctors"])

    if mode != "open":
        # re-read right before writing: the download + parse above takes over a minute and
        # doctors keep tapping meanwhile - their marks must not be overwritten
        live = db.get("days/" + date)
    stamp = dt.datetime.now(CAIRO).isoformat()
    if mode == "open" or live is None:
        parsed.update({"status": "open", "importedAt": stamp})
        parsed["doctors"] = {d["key"]: d for d in parsed["doctors"]}
        db.set("days/" + date, parsed)
        print("imported %s: %d doctors, %d sessions" % (
            parsed["sheet"], len(parsed["doctors"]), sum(len(d["sessions"]) for d in parsed["doctors"].values())))
        return

    doctors, changed = merge_final(live, parsed)
    live.update({"doctors": doctors, done_key: stamp, "sheet": parsed["sheet"]})
    if changed and live.get("status") == "closed":
        live["status"] = "open"                      # someone has to re-check a changed schedule
    elif live.get("status") == "open" and all(d.get("submitted") for d in doctors.values()):
        live["status"] = "closed"; live["closedAt"] = stamp
    db.set("days/" + date, live)
    if live["status"] == "closed":
        db.set("stats/" + date, {"date": date, "doctors": summarize(live)})
    print("%s for %s: %d doctors, changed: %s" % (mode, date, len(doctors), ", ".join(changed) or "none"))


if __name__ == "__main__":
    sys.exit(main())
