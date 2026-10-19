"""Daily job (GitHub Actions).

9 AM Cairo: close any older day still open (doctors who did not submit keep what they
            marked), then build today's schedule from the booking workbook - all white.
9 PM Cairo: read today's tab again; the latest version is the final schedule.

Env: SHARE_URL, FIREBASE_API_KEY, FIREBASE_PROJECT, IMPORTER_EMAIL, IMPORTER_PASSWORD
     MODE=open|final to run outside the time windows, DAY=YYYY-MM-DD for another day.
"""
import datetime as dt
import http.cookiejar
import os
import re
import sys
import tempfile
import urllib.request
from zoneinfo import ZoneInfo

from firestore_rest import Firestore, sign_in
from parse_day import parse_day

CAIRO = ZoneInfo("Africa/Cairo")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"


def download_workbook(share_url, dest):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [("User-Agent", UA)]
    page = opener.open(share_url, timeout=120).read().decode("utf-8", "replace")
    m = re.search(r'"FileGetUrl":"([^"]+)"', page)
    if not m:
        raise RuntimeError("download link not found - is the share link still open to anyone?")
    url = m.group(1).replace("\\u0026", "&")
    data = opener.open(url, timeout=300).read()
    if data[:2] != b"PK":
        raise RuntimeError("download did not return an xlsx file")
    with open(dest, "wb") as f:
        f.write(data)


def summarize(day):
    out = {}
    for key, d in (day.get("doctors") or {}).items():
        ss = d.get("sessions", [])
        out[key] = {
            "name": d["name"],
            "section": d.get("section", ""),
            "submitted": bool(d.get("submitted")),
            "booked": sum(s.get("units", 1) for s in ss),
            "attended": sum(s.get("units", 1) for s in ss if s.get("status") == 1),
            "cases": sum(1 for s in ss if s.get("status") == 1),
            "noShow": sum(1 for s in ss if s.get("status") == 2),
            "unmarked": sum(1 for s in ss if not s.get("status")),
        }
    return out


def _sig(sess):
    return (sess["start"], sess["end"], re.sub(r"\s+", " ", sess["patient"]).strip())


def merge_final(live, parsed):
    """9 PM: the sheet's latest version becomes the final schedule.

    Marks are kept for every session that is still there (same time + patient).
    A doctor whose list of sessions did not change keeps their Submit; a doctor
    whose schedule changed is un-submitted (with a note) so they review it again.
    Returns (new doctors map, names of doctors whose schedule changed).
    """
    old_by_name = {d["name"]: d for d in (live.get("doctors") or {}).values()}
    doctors, changed = {}, []
    for d in parsed["doctors"]:
        old = old_by_name.get(d["name"])
        if old:
            marks = {_sig(x): x.get("status", 0) for x in old.get("sessions", [])}
            for x in d["sessions"]:
                x["status"] = marks.get(_sig(x), 0)
            same = sorted(map(_sig, old.get("sessions", []))) == sorted(map(_sig, d["sessions"]))
            if same:
                for k in ("submitted", "submittedAt"):
                    if k in old:
                        d[k] = old[k]
            else:
                changed.append(d["name"])
                d["changedAt"] = dt.datetime.now(CAIRO).isoformat()
                d["submitted"] = False
        else:
            changed.append(d["name"])
        doctors[d["key"]] = d
    return doctors, changed


def close_day(db, date, doc):
    db.set("stats/" + date, {"date": date, "doctors": summarize(doc), "autoClosed": True})
    db.update("days/" + date, {"status": "closed", "autoClosed": True,
                               "closedAt": dt.datetime.now(CAIRO).isoformat()})
    print("auto-closed", date)


def main():
    """MODE=open (9 AM): close yesterday, create today's schedule.
       MODE=final (9 PM): re-read today's tab, it becomes the final schedule.
       Without MODE the Cairo hour decides (9-10 -> open, 21-22 -> final)."""
    now = dt.datetime.now(CAIRO)
    mode = os.environ.get("MODE") or {9: "open", 10: "open", 21: "final", 22: "final"}.get(now.hour)
    if not mode:
        print("nothing to do at %s Cairo" % now.strftime("%H:%M"))
        return
    day = dt.date.fromisoformat(os.environ["DAY"]) if os.environ.get("DAY") else now.date()
    date = day.isoformat()

    token = sign_in(os.environ["FIREBASE_API_KEY"], os.environ["IMPORTER_EMAIL"], os.environ["IMPORTER_PASSWORD"])
    db = Firestore(os.environ["FIREBASE_PROJECT"], token)

    if mode == "open":
        for d, doc in db.query_eq("days", "status", "open"):
            if d < date:
                close_day(db, d, doc)
    live = db.get("days/" + date)
    if mode == "open" and live is not None:
        print("days/%s already exists - skipping" % date)
        return
    if mode == "final" and live and live.get("finalAt") and not os.environ.get("MODE"):
        print("final schedule for %s already taken at %s - skipping" % (date, live["finalAt"]))
        return

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "book.xlsx")
        download_workbook(os.environ["SHARE_URL"], path)
        parsed = parse_day(path, day)
    if not parsed or not parsed["doctors"]:
        print("no tab for %s in the workbook - nothing imported" % day)
        return

    stamp = dt.datetime.now(CAIRO).isoformat()
    if mode == "open" or live is None:
        parsed.update({"status": "open", "importedAt": stamp})
        parsed["doctors"] = {d["key"]: d for d in parsed["doctors"]}
        db.set("days/" + date, parsed)
        print("imported %s: %d doctors, %d sessions" % (
            parsed["sheet"], len(parsed["doctors"]), sum(len(d["sessions"]) for d in parsed["doctors"].values())))
        return

    doctors, changed = merge_final(live, parsed)
    live.update({"doctors": doctors, "finalAt": stamp, "sheet": parsed["sheet"]})
    if changed and live.get("status") == "closed":
        live["status"] = "open"                      # someone has to re-check a changed schedule
    elif live.get("status") == "open" and all(d.get("submitted") for d in doctors.values()):
        live["status"] = "closed"; live["closedAt"] = stamp
    db.set("days/" + date, live)
    if live["status"] == "closed":
        db.set("stats/" + date, {"date": date, "doctors": summarize(live)})
    print("final schedule for %s: %d doctors, changed: %s" % (date, len(doctors), ", ".join(changed) or "none"))


if __name__ == "__main__":
    sys.exit(main())
