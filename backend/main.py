from datetime import datetime, timedelta, timezone
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
from supabase import create_client
from passlib.hash import pbkdf2_sha256
import jwt
import json
from dotenv import load_dotenv
from sync_logic import merge_lessons

app = FastAPI()

# CORS für Frontend-Zugriff (iPad/Smartphone)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Supabase Client initialisieren
# Diese Werte MÜSSEN in deinem Cloud-Dashboard als Environment Variables gesetzt sein!
load_dotenv()
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
APP_AUTH_SECRET = os.environ.get("APP_AUTH_SECRET")
APP_AUTH_TOKEN_TTL = int(os.environ.get("APP_AUTH_TOKEN_TTL", "2592000"))
print(f"Supabase config: url set={bool(SUPABASE_URL)}, key set={bool(SUPABASE_KEY)}")
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# --- USER AUTH (Bleibt in users_auth.json, da klein und selten geändert) ---
BASE_DATA_DIR = "data"
USER_DB_PATH = os.path.join(BASE_DATA_DIR, "users_auth.json")

def load_user_db():
    if os.path.exists(USER_DB_PATH):
        with open(USER_DB_PATH, "r") as f: return json.load(f)
    return {}

class UserAuth(BaseModel):
    username: str
    password: str

@app.post("/api/register")
def register(user: UserAuth):
    db = load_user_db()
    if user.username in db: raise HTTPException(status_code=400, detail="Existiert bereits")
    db[user.username] = pbkdf2_sha256.hash(user.password)
    os.makedirs(BASE_DATA_DIR, exist_ok=True)
    with open(USER_DB_PATH, "w") as f: json.dump(db, f)
    return {"status": "success"}

@app.post("/login")
def login(user: UserAuth):
    # Suche den User in der neuen Tabelle
    response = supabase.table("users")\
        .select("username,password_hash")\
        .eq("username", user.username)\
        .limit(1)\
        .execute()

    user_record = response.data[0] if response.data else None
    if user_record and pbkdf2_sha256.verify(user.password, user_record["password_hash"]):
        if not APP_AUTH_SECRET:
            raise HTTPException(status_code=503, detail="APP_AUTH_SECRET ist auf dem Backend nicht konfiguriert")
        username = user_record["username"]
        token = jwt.encode({
            "sub": username,
            "exp": datetime.now(timezone.utc) + timedelta(seconds=APP_AUTH_TOKEN_TTL),
        }, APP_AUTH_SECRET, algorithm="HS256")
        return {"status": "success", "username": username, "access_token": token}
    
    raise HTTPException(status_code=400, detail="Falsche Logindaten")


def authenticated_user(authorization: str = Header(default="")) -> str:
    if not APP_AUTH_SECRET or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Anmeldung erforderlich")
    token = authorization.removeprefix("Bearer ")
    try:
        payload = jwt.decode(token, APP_AUTH_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Sitzung ungültig oder abgelaufen")
    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=401, detail="Sitzung enthält keinen Nutzer")
    return username
    
# --- VOKABEL-LOGIK (Jetzt komplett in Supabase) ---

@app.get("/api/vocab/{username}/{lang}")
def get_vocab(username: str, lang: str, authenticated_username: str = Depends(authenticated_user)):
    if username != authenticated_username:
        raise HTTPException(status_code=403, detail="Zugriff auf diesen Nutzer ist nicht erlaubt")
    if lang.lower() not in {"latein", "englisch"}:
        raise HTTPException(status_code=422, detail="Nicht unterstützte Sprache")
    try:
        response = supabase.table("vokabeln")\
            .select("*")\
            .eq("user", username)\
            .eq("sprache", lang.lower())\
            .execute()
        
        lessons = {}
        for row in response.data:
            lexikon = row["lexikon"]
            if lexikon not in lessons: lessons[lexikon] = []
            lessons[lexikon].append({
                "wort": row["wort"], "uebersetzung": row["uebersetzung"],
                "genus": row["genus"], "status": row["status"],
                "richtig": row["richtig"], "falsch": row["falsch"],
                "updated_at": row.get("updated_at")
            })
        return lessons
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class SyncData(BaseModel):
    lessons: dict

@app.get("/api/debug")
def debug():
    return {
        "SUPABASE_URL_set": bool(SUPABASE_URL),
        "SUPABASE_KEY_set": bool(SUPABASE_KEY),
        "SUPABASE_URL": "set" if SUPABASE_URL else "missing",
        "SUPABASE_KEY": "set" if SUPABASE_KEY else "missing"
    }

@app.post("/api/sync/{username}/{lang}")
def sync_vocab(username: str, lang: str, data: SyncData, authenticated_username: str = Depends(authenticated_user)):
    if username != authenticated_username:
        raise HTTPException(status_code=403, detail="Zugriff auf diesen Nutzer ist nicht erlaubt")
    if lang.lower() not in {"latein", "englisch"}:
        raise HTTPException(status_code=422, detail="Nicht unterstützte Sprache")
    try:
        for lesson_name, vocabs in data.lessons.items():
            if lesson_name in ["nochmal", "gut", "f-nochmal", "f-gut"]:
                continue
            if not isinstance(lesson_name, str) or not lesson_name.strip():
                raise HTTPException(status_code=422, detail="Ungültiger Lexikonname")
            if not isinstance(vocabs, list):
                raise HTTPException(status_code=422, detail=f"Lektion {lesson_name} muss eine Vokabelliste sein")

            existing_response = supabase.table("vokabeln")\
                .select("*")\
                .eq("user", username)\
                .eq("sprache", lang.lower())\
                .eq("lexikon", lesson_name)\
                .execute()

            merged_rows = merge_lessons(existing_response.data or [], {lesson_name: vocabs}, username, lang)

            payloads = []
            for row in merged_rows:
                if not isinstance(row, dict) or not row.get("wort"):
                    continue
                payload = {
                    "user": username,
                    "sprache": lang.lower(),
                    "lexikon": lesson_name,
                    "wort": row["wort"],
                    "uebersetzung": row.get("uebersetzung"),
                    "genus": row.get("genus", ""),
                    "status": row.get("status", "neu"),
                    "richtig": row.get("richtig", 0),
                    "falsch": row.get("falsch", 0),
                    "updated_at": row.get("updated_at") or datetime.utcnow().isoformat() + "Z",
                }
                if row.get("origin_file") is not None:
                    payload["origin_file"] = row["origin_file"]
                payloads.append(payload)

            if payloads:
                supabase.table("vokabeln").upsert(
                    payloads,
                    on_conflict="user,sprache,lexikon,wort"
                ).execute()
        return {"status": "synced"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))