"""Tiny Firestore REST client (signs in as the importer account)."""
import json
import urllib.error
import urllib.request


def _req(method, url, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise RuntimeError("%s %s -> %s %s" % (method, url, e.code, e.read()[:500]))


def sign_in(api_key, email, password):
    r = _req("POST", "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + api_key,
             {"email": email, "password": password, "returnSecureToken": True})
    return r["idToken"]


def to_value(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [to_value(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: to_value(x) for k, x in v.items()}}}
    raise TypeError(type(v))


def from_value(v):
    if "mapValue" in v:
        return {k: from_value(x) for k, x in v["mapValue"].get("fields", {}).items()}
    if "arrayValue" in v:
        return [from_value(x) for x in v["arrayValue"].get("values", [])]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "doubleValue" in v:
        return v["doubleValue"]
    if "booleanValue" in v:
        return v["booleanValue"]
    if "nullValue" in v:
        return None
    return next(iter(v.values()))


class Firestore:
    def __init__(self, project, token):
        self.base = "https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents" % project
        self.token = token

    def get(self, path):
        r = _req("GET", "%s/%s" % (self.base, path), token=self.token)
        return None if r is None else {k: from_value(v) for k, v in r.get("fields", {}).items()}

    def set(self, path, data):
        _req("PATCH", "%s/%s" % (self.base, path),
             {"fields": {k: to_value(v) for k, v in data.items()}}, token=self.token)

    def update(self, path, data):
        mask = "&".join("updateMask.fieldPaths=" + k for k in data)
        _req("PATCH", "%s/%s?%s" % (self.base, path, mask),
             {"fields": {k: to_value(v) for k, v in data.items()}}, token=self.token)

    def query_eq(self, collection, field, value):
        body = {"structuredQuery": {
            "from": [{"collectionId": collection}],
            "where": {"fieldFilter": {"field": {"fieldPath": field}, "op": "EQUAL", "value": to_value(value)}}}}
        rows = _req("POST", self.base + ":runQuery", body, token=self.token) or []
        out = []
        for row in rows:
            doc = row.get("document")
            if doc:
                out.append((doc["name"].rsplit("/", 1)[1],
                            {k: from_value(v) for k, v in doc.get("fields", {}).items()}))
        return out
