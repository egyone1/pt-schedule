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

# other ways the secretaries write the same treatment (seen in the sheet, Nov 2026)
ALIASES = {
    "hotpack": "Hot pack / Magnet", "hot pak": "Hot pack / Magnet", "hotmag": "Hot pack / Magnet",
    "hot mag": "Hot pack / Magnet", "hmgt": "Hot pack / Magnet", "h mgt": "Hot pack / Magnet",
    "hot magnet": "Hot pack / Magnet", "magnet": "Hot pack / Magnet",
    "shock wave": "Shockwave", "shockeave": "Shockwave", "shokwave": "Shockwave",
    "air walk": "Air walker", "airwalk": "Air walker", "air walker": "Air walker",
    "isis": "ISIS", "vib": "Vibration", "vibration": "Vibration",
    "gate": "Gait", "spech": "Speech", "copm": "Compression", "balanc": "Balance", "balane": "Balance",
    "blance": "Balance", "exercise": "EX", "exercises": "EX", "parallel bar": "PB", "wall bar": "WB", "wallbar": "WB",
}
_KNOWN = {**TREATMENTS, **ALIASES}


def _dist(a, b):
    """Levenshtein distance (small words only)."""
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def split_glued(word):
    """Two treatments written without a space ("laserbibatron") -> [names]; [] if it doesn't split cleanly."""
    if len(word) < 6 or not word.isalpha():
        return []
    for i in range(2, len(word) - 1):
        a, b = word[:i], word[i:]
        if a in _KNOWN and b in _KNOWN and len(a) >= 2 and len(b) >= 2:
            return [_KNOWN[a], _KNOWN[b]]
    return []


def lookup(key):
    """Treatment name for a written code: exact, a known other spelling, or a small typo
    (1 letter off for words of 4+ letters, 2 for 7+; short codes like es / ex / us must be exact)."""
    key = re.sub(r"\s+", " ", key or "").strip()
    if key in _KNOWN:
        return _KNOWN[key]
    if len(key) < 4 or not re.fullmatch(r"[a-z ]+", key):
        return None
    limit = 2 if len(key) >= 7 else 1
    best = sorted((_dist(key, k), k) for k in _KNOWN if len(k) >= 4 and abs(len(k) - len(key)) <= limit)
    if best and best[0][0] <= limit and (len(best) == 1 or best[1][0] > best[0][0]
                                          or _KNOWN[best[1][1]] == _KNOWN[best[0][1]]):
        return _KNOWN[best[0][1]]
    return None


def _scan(details):
    """-> ([(treatment name, times)], whole_x2). Codes may be joined by + or only by spaces ("mt us x2");
    an "x2" standing on its own marks the cell as x2."""
    codes, whole = [], False
    for part in re.split(r"[+·,/\n]", str(details or "").lower()):
        if _WHOLE_X2.match(part):
            whole = True
            continue
        key = _STRIP_X(part)
        if lookup(key):
            codes.append((lookup(key), 2 if _TWICE.search(part) else 1))
            continue
        toks, i = part.split(), 0                       # "mt us x2", "mt*2 us *2"
        while i < len(toks):
            if _WHOLE_X2.match(toks[i]):
                whole = True
                i += 1
                continue
            two = " ".join(toks[i:i + 2])
            if i + 1 < len(toks) and _STRIP_X(two) in _KNOWN:          # "hot mgt", "scanner laser", "shock wave"
                codes.append((_KNOWN[_STRIP_X(two)], 2 if _TWICE.search(two) else 1))
                i += 2
                continue
            name = lookup(_STRIP_X(toks[i]))
            if name:
                codes.append((name, 2 if _TWICE.search(toks[i]) else 1))
            else:                                                   # "laserbibatron" -> laser + bibatron
                codes.extend((n, 1) for n in split_glued(_STRIP_X(toks[i])))
            i += 1
    return codes, whole


def parse_codes(details):
    """-> [(treatment name, times)] for the known codes in the cell."""
    return _scan(details)[0]


# notes that are not treatments (new patient, re-evaluation, icu, vip...) - never reported as "not understood"
NOT_TREATMENT = {"n", "new", "neww", "ree", "re", "reev", "vip", "top", "icu", "in", "inpatient", "inpateint", "out",
                 "outpatient", "assessment", "assisment", "assesment", "session", "sessions", "x", "pt", "ped", "r", "l",
                 "rt", "lt", "only", "dr", "d", "cash", "package", "pkg", "free", "follow", "up", "eval", "evaluation",
                 "first", "trial", "home", "visit", "online", "ot", "aq", "test"}
_KNOWN_WORDS = {w for k in _KNOWN for w in k.split()}


def unknown_words(details):
    """Latin words in the cell that were not understood as a treatment (for the admin to check)."""
    out = []
    for w in re.findall(r"[a-z]+", str(details or "").lower()):
        w2 = re.sub(r"x$", "", w) if len(w) > 2 else w          # "mtx" from "mtx2"
        if w in _KNOWN_WORDS or w2 in _KNOWN_WORDS or w in NOT_TREATMENT or lookup(w) or lookup(w2) or split_glued(w):
            continue
        if w not in out:
            out.append(w)
    return out


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
