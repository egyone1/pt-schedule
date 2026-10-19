"""Nightly job (GitHub Actions, 9 PM Cairo).

1. close any day that is still open (doctors who did not submit keep what they marked)
2. download the booking workbook from the SharePoint share link
3. build today's schedule and store it as days/<date> with every session white

Env: SHARE_URL, FIREBASE_API_KEY, FIREBASE_PROJECT, IMPORTER_EMAIL, IMPORTER_PASSWORD
     FORCE=1 to run outside the 9 PM window, DAY=YYYY-MM-DD to import another day.
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


def main():
    now = dt.datetime.now(CAIRO)
    force = os.environ.get("FORCE") == "1"
    if not force and now.hour not in (21, 22):
        print("not 9 PM in Cairo (%s) - nothing to do" % now.strftime("%H:%M"))
        return
    day = dt.date.fromisoformat(os.environ["DAY"]) if os.environ.get("DAY") else now.date()

    token = sign_in(os.environ["FIREBASE_API_KEY"], os.environ["IMPORTER_EMAIL"], os.environ["IMPORTER_PASSWORD"])
    db = Firestore(os.environ["FIREBASE_PROJECT"], token)

    if db.get("days/" + day.isoformat()) is not None:
        print("days/%s already exists - skipping" % day)
        return

    for date, doc in db.query_eq("days", "status", "open"):
        if date >= day.isoformat():
            continue
        db.set("stats/" + date, {"date": date, "doctors": summarize(doc), "autoClosed": True})
        db.update("days/" + date, {"status": "closed", "autoClosed": True,
                                   "closedAt": dt.datetime.now(CAIRO).isoformat()})
        print("auto-closed", date)

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "book.xlsx")
        download_workbook(os.environ["SHARE_URL"], path)
        parsed = parse_day(path, day)
    if not parsed or not parsed["doctors"]:
        print("no tab for %s in the workbook - nothing imported" % day)
        return

    parsed.update({"status": "open", "importedAt": dt.datetime.now(CAIRO).isoformat()})
    parsed["doctors"] = {d["key"]: d for d in parsed["doctors"]}
    db.set("days/" + day.isoformat(), parsed)
    print("imported %s: %d doctors, %d sessions" % (
        parsed["sheet"], len(parsed["doctors"]), sum(len(d["sessions"]) for d in parsed["doctors"].values())))


if __name__ == "__main__":
    sys.exit(main())
