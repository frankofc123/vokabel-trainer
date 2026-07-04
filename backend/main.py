from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
from supabase import create_client
from passlib.hash import pbkdf2_sha256
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
        .select("password_hash")\
        .ilike("username", user.username)\
        .single()\
        .execute()

    if response.data and pbkdf2_sha256.verify(user.password, response.data["password_hash"]):
        return {"status": "success", "username": user.username}
    
    raise HTTPException(status_code=400, detail="Falsche Logindaten")
    
# --- VOKABEL-LOGIK (Jetzt komplett in Supabase) ---

@app.get("/api/vocab/{username}/{lang}")
def get_vocab(username: str, lang: str):
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

@app.post("/api/sync/{username}/{lang}")
def sync_vocab(username: str, lang: str, data: SyncData):
    try:
        for lesson_name, vocabs in data.lessons.items():
            if lesson_name in ["nochmal", "gut", "f-nochmal", "f-gut"]:
                continue

            existing_response = supabase.table("vokabeln")\
                .select("*")\
                .eq("user", username)\
                .eq("sprache", lang.lower())\
                .eq("lexikon", lesson_name)\
                .execute()

            merged_rows = merge_lessons(existing_response.data or [], {lesson_name: vocabs}, username, lang)

            supabase.table("vokabeln").delete()\
                .eq("user", username).eq("sprache", lang.lower()).eq("lexikon", lesson_name).execute()

            payloads = [{
                "user": row.get("user", username),
                "sprache": row.get("sprache", lang.lower()),
                "lexikon": row.get("lexikon", lesson_name),
                "wort": row.get("wort"),
                "uebersetzung": row.get("uebersetzung"),
                "genus": row.get("genus", ""),
                "status": row.get("status", "neu"),
                "richtig": row.get("richtig", 0),
                "falsch": row.get("falsch", 0),
                "updated_at": row.get("updated_at")
            } for row in merged_rows if isinstance(row, dict) and row.get("wort")]

            if payloads:
                supabase.table("vokabeln").insert(payloads).execute()
        return {"status": "synced"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))