"""What the secretaries write in a booking cell -> treatments and number of sessions.

Session rule (from the head of department, Oct 2026):
  * ex, balance, pb, wb and gait are each a session of their own, even next to other treatments;
  * all the other treatments in the cell together are one session - MT x2 (mt*2, mtx2, 2mt) makes it two;
  * any other x2 ("mt us x2", "mt+us*2", "mt+es · x2") is read from the length (Nov 2026): the whole session
    twice takes more than an hour, one treatment repeated (mt + 2 us) fits in 45-60 min ->
    over 60 minutes = two sessions, otherwise one;
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


_WHOLE_X2 = re.compile(r"^\s*([*x×]\s*2|2\s*[*x×])\s*$")
_STRIP_X = lambda t: re.sub(r"[*x×]?\s*\d+|\d+\s*[*x×]", "", t).strip(" *\"'\t")


def _scan(details):
    """-> ([(treatment name, times)], whole_x2). Codes may be joined by + or only by spaces ("mt us x2");
    an "x2" standing on its own marks the cell as x2."""
    codes, whole = [], False
    for part in re.split(r"[+·,/\n]", str(details or "").lower()):
        if _WHOLE_X2.match(part):
            whole = True
            continue
        key = _STRIP_X(part)
        if key in TREATMENTS:
            codes.append((TREATMENTS[key], 2 if _TWICE.search(part) else 1))
            continue
        toks, i = part.split(), 0                       # "mt us x2", "mt*2 us *2"
        while i < len(toks):
            if _WHOLE_X2.match(toks[i]):
                whole = True
                i += 1
                continue
            two = " ".join(toks[i:i + 2])
            if i + 1 < len(toks) and _STRIP_X(two) in TREATMENTS:     # "hot mgt", "scanner laser"
                codes.append((TREATMENTS[_STRIP_X(two)], 2 if _TWICE.search(two) else 1))
                i += 2
                continue
            if _STRIP_X(toks[i]) in TREATMENTS:
                codes.append((TREATMENTS[_STRIP_X(toks[i])], 2 if _TWICE.search(toks[i]) else 1))
            i += 1
    return codes, whole


def parse_codes(details):
    """-> [(treatment name, times)] for the known codes in the cell."""
    return _scan(details)[0]


def treatments_of(details):
    out = {}
    for name, times in parse_codes(details):
        out[name] = out.get(name, 0) + times
    return out


def units_of(details, minutes=None):
    codes, whole_x2 = _scan(details)
    long = (minutes or 0) > 60                     # the whole session twice takes more than an hour
    own = sum(t for n, t in codes if n in OWN_SESSION)
    rest = [(n, t) for n, t in codes if n not in OWN_SESSION]
    mt2 = any(n == "MT" and t == 2 for n, t in rest)
    other_x2 = whole_x2 or any(n != "MT" and t == 2 for n, t in rest)
    base = (2 if mt2 or (other_x2 and long) else 1) if rest else 0
    if whole_x2 and long and not rest:
        own = own * 2 if own else 2
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
              "wb", "pb · n", "aq", "mt · icu", "mt+es+shockeave · x2", "mt+es*2", "mt+es x2", "Speech*2",
              "scanner laserx2+bibatronx2", "ex · x2", "mld+comp"]:
        print("%-16s -> %d   %s" % (t, units_of(t), treatments_of(t)))
