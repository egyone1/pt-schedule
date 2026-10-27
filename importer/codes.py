"""What the secretaries write in a booking cell -> treatments and number of sessions.

Session rule (from the head of department, Oct 2026):
  * ex, balance, pb, wb and gait are each a session of their own, even next to other treatments;
  * all the other treatments in the cell together are one session - "mt2" (mt*2, mtx2, 2mt) makes it two;
  * a cell with only the patient's name is one session.
Keep in step with treatmentsOf / unitsOf in store.js.
"""
import re

TREATMENTS = {
    "mt": "MT", "es": "ES", "us": "US", "ex": "EX", "laser": "Laser", "scanner laser": "Laser", "shockwave": "Shockwave",
    "shock": "Shockwave", "hot mgt": "Hot pack / Magnet", "hotmgt": "Hot pack / Magnet", "mgt": "Hot pack / Magnet",
    "hotpak": "Hot pack / Magnet", "hot pack": "Hot pack / Magnet", "balance": "Balance", "gait": "Gait", "pb": "PB",
    "schroth": "Schroth", "scroth": "Schroth", "shroth": "Schroth", "aq": "Aqua", "ot": "OT", "mld": "MLD",
    "bandage": "Bandaging", "bandaging": "Bandaging", "comp": "Compression", "pressure": "Compression",
    "lymph press": "Compression", "chest": "Chest", "tilt": "Tilt table", "thera": "Thera", "wb": "WB",
    "standing": "Standing", "biofeedback": "Biofeedback", "biofeed back": "Biofeedback", "bladder": "Bladder rehab",
    "speech": "Speech", "release": "Release", "bibatron": "Bibatron", "tecar": "Tecar", "traction": "Traction",
}
OWN_SESSION = {"EX", "Balance", "PB", "WB", "Gait"}      # each one is a session by itself

RED = {"FFFF0000", "FFC00000"}                          # cancelled in the booking sheet
YELLOW = {"FFFFFF00"}                                   # inpatient in the booking sheet

_TWICE = re.compile(r"[*x×]\s*2|2\s*[*x×]|^\s*2\s*[a-z]|[a-z]\s*2\s*$")


def parse_codes(details):
    """-> [(treatment name, times)] for the known codes in the cell."""
    out = []
    for part in re.split(r"[+·,/\n]", str(details or "").lower()):
        times = 2 if _TWICE.search(part) else 1
        key = re.sub(r"[*x×]?\s*\d+|\d+\s*[*x×]", "", part).strip(" *\"'\t")
        name = TREATMENTS.get(key)
        if name:
            out.append((name, times))
    return out


def treatments_of(details):
    out = {}
    for name, times in parse_codes(details):
        out[name] = out.get(name, 0) + times
    return out


def units_of(details):
    codes = parse_codes(details)
    own = sum(t for n, t in codes if n in OWN_SESSION)
    rest = [(n, t) for n, t in codes if n not in OWN_SESSION]
    base = (2 if any(n == "MT" and t == 2 for n, t in rest) else 1) if rest else 0
    return max(1, base + own)


def sheet_mark(cell):
    """'red' (cancelled), 'yellow' (inpatient) or '' from the cell's fill."""
    f = cell.fill
    if not f or f.fill_type != "solid" or f.fgColor.type != "rgb" or not isinstance(f.fgColor.rgb, str):
        return ""
    rgb = f.fgColor.rgb.upper()
    return "red" if rgb in RED else "yellow" if rgb in YELLOW else ""


if __name__ == "__main__":
    for t in ["mt+es+us", "ex", "mt+es+ex", "ex+balance", "mt*2+es", "mt*2+ex+gait", "", "2mt+es", "mtx2+shockwave",
              "wb", "pb · n", "aq", "mt · icu"]:
        print("%-16s -> %d   %s" % (t, units_of(t), treatments_of(t)))
