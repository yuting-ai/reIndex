from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from sqlalchemy.orm import Session
from sqlalchemy import select, update
import json
from typing import List, Optional
import os

from app.database import init_db, FileIndex, MemoryRecord, ChangeLog
from app import vector_db
import subprocess
from fastapi import BackgroundTasks
from scripts.scanner import scan_directory
import time
import socket

from pydantic import BaseModel

from app.graph_db import graph_db as neo4j_graph
from app.llm_connector import extract_triplets
from app.watcher import load_and_watch_saved_folders, save_and_watch_folders, set_scan_callback

app = FastAPI(title="reIndex API")

@app.on_event("startup")
def startup_event():
    # Start the watchdog observer for all previously tracked folders
    load_and_watch_saved_folders()
    _ensure_neo4j_running()

def _ensure_neo4j_running():
    """Check if Neo4j is reachable; if not, try to start the Docker container."""
    def _is_neo4j_up():
        try:
            with socket.create_connection(("127.0.0.1", 7687), timeout=2):
                return True
        except (OSError, ConnectionRefusedError):
            return False

    if _is_neo4j_up():
        print("✓ Neo4j already running")
        return

    print("⟳ Neo4j not reachable, attempting to start Docker container...")
    try:
        subprocess.run(
            ["docker", "start", "neo4j_reindex"],
            capture_output=True, text=True, timeout=15,
        )
        # Wait up to 20s for Neo4j to become ready
        for attempt in range(20):
            if _is_neo4j_up():
                print("✓ Neo4j container started successfully")
                return
            time.sleep(1)
        print("✗ Neo4j container failed to become ready within 20s")
    except Exception as e:
        print(f"✗ Failed to start Neo4j: {e}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allow Vite frontend
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize database engine
engine = init_db()

# Dependency to get a database session
def get_db():
    with Session(engine) as session:
        yield session

@app.get("/api/files")
def list_files(status: str = "active", db: Session = Depends(get_db)):
    """Returns files based on status (active or trash)."""
    is_del = True if status == "trash" else False
    stmt = select(FileIndex).where(FileIndex.is_deleted == is_del).order_by(FileIndex.last_modified.desc())
    files = db.scalars(stmt).all()
    
    result = []
    for f in files:
        status = "none"
        if len(f.memory_records) > 0:
            status = "full"
            
        result.append({
            "id": f.id,
            "file_name": f.file_name,
            "file_path": f.file_path,
            "file_type": f.file_type,
            "file_size": f.file_size,
            "last_modified": f.last_modified,
            "mem_status": status
        })
    return result

class BatchDeleteRequest(BaseModel):
    file_ids: List[str]

@app.post("/api/files/batch-trash")
def batch_trash_files(request: BatchDeleteRequest, db: Session = Depends(get_db)):
    """Soft deletes files by marking is_deleted=True so they can be recovered later."""
    for fid in request.file_ids:
        stmt = select(FileIndex).where(FileIndex.id == fid)
        f_record = db.scalar(stmt)
        if f_record and not f_record.is_deleted:
            f_record.is_deleted = True
            
            # Log the trash action
            log = ChangeLog(file=f_record, operation="TRASHED", old_path=f_record.file_path)
            db.add(log)
            
            # Keep Qdrant vectors and MemoryRecords for restore, but remove Neo4j graph data
            try:
                neo4j_graph.delete_file_triplets(fid)
            except Exception as e:
                print(f"Neo4j cleanup failed for {fid}: {e}")
            
    db.commit()
    return {"message": f"Moved {len(request.file_ids)} files to trash successfully"}

@app.post("/api/files/batch-restore")
def batch_restore_files(request: BatchDeleteRequest, db: Session = Depends(get_db)):
    """Restores soft-deleted files and re-syncs Neo4j graph data."""
    for fid in request.file_ids:
        stmt = select(FileIndex).where(FileIndex.id == fid)
        f_record = db.scalar(stmt)
        if f_record and f_record.is_deleted:
            f_record.is_deleted = False
            log = ChangeLog(file=f_record, operation="RESTORED", old_path=f_record.file_path)
            db.add(log)
            
            # Re-add Neo4j triplets from the stored memory content
            try:
                mem_stmt = select(MemoryRecord).where(MemoryRecord.file_id == fid)
                memory = db.scalar(mem_stmt)
                if memory and memory.content_text:
                    triplets = extract_triplets(memory.content_text)
                    if triplets:
                        neo4j_graph.add_triplets(fid, triplets)
            except Exception as e:
                print(f"Neo4j restore failed for {fid}: {e}")
            
    db.commit()
    return {"message": f"Restored {len(request.file_ids)} files successfully"}

@app.post("/api/files/batch-delete-permanent")
def batch_delete_permanent(request: BatchDeleteRequest, db: Session = Depends(get_db)):
    """Permanently deletes files (Hard Delete) and cleans up all associated data."""
    for fid in request.file_ids:
        vector_db.delete_file_vectors(fid)
        try:
            neo4j_graph.delete_file_triplets(fid)
        except Exception as e:
            print(f"Neo4j cleanup failed for {fid}: {e}")
        stmt = select(FileIndex).where(FileIndex.id == fid)
        f_record = db.scalar(stmt)
        if f_record:
            stmt_logs = select(ChangeLog).where(ChangeLog.file_id == fid)
            for log in db.scalars(stmt_logs).all():
                db.delete(log)
            db.delete(f_record)
    db.commit()
    return {"message": f"Permanently deleted {len(request.file_ids)} files"}

@app.get("/api/files/{file_id}")
def get_file_detail(file_id: str, db: Session = Depends(get_db)):
    """Returns file details along with its AI-generated memory summary."""
    stmt = select(FileIndex).where(FileIndex.id == file_id)
    file_record = db.scalar(stmt)
    
    if not file_record:
        raise HTTPException(status_code=404, detail="File not found")
        
    # Get memory records
    mem_stmt = select(MemoryRecord).where(MemoryRecord.file_id == file_id)
    memory_records = db.scalars(mem_stmt).all()
    
    memories = [
        {
            "summary": m.summary,
            "key_entities": m.key_entities,
        }
        for m in memory_records
    ]
    
    # Get change logs
    log_stmt = select(ChangeLog).where(ChangeLog.file_id == file_id).order_by(ChangeLog.timestamp.desc())
    logs = db.scalars(log_stmt).all()
    change_logs = [
        {
            "operation": l.operation,
            "timestamp": l.timestamp.isoformat(),
            "old_path": l.old_path,
            "new_path": l.new_path,
        }
        for l in logs
    ]
    
    return {
        "id": file_record.id,
        "file_name": file_record.file_name,
        "file_path": file_record.file_path,
        "file_type": file_record.file_type,
        "is_deleted": file_record.is_deleted,
        "memories": memories,
        "change_logs": change_logs
    }

@app.get("/api/files/{file_id}/source")
def get_file_source(file_id: str, db: Session = Depends(get_db)):
    """Second-level retrieval: returns the original file text stored in MemoryRecord."""
    mem_stmt = select(MemoryRecord).where(MemoryRecord.file_id == file_id)
    memory = db.scalar(mem_stmt)
    
    if not memory or not memory.content_text:
        raise HTTPException(status_code=404, detail="No source content available for this file")
    
    return {
        "file_id": file_id,
        "content": memory.content_text
    }

@app.get("/api/files/{file_id}/logs")
def get_file_logs(file_id: str, db: Session = Depends(get_db)):
    """Returns operation logs for a specific file."""
    stmt = select(ChangeLog).where(ChangeLog.file_id == file_id).order_by(ChangeLog.timestamp.desc())
    logs = db.scalars(stmt).all()
    
    result = []
    for log in logs:
        result.append({
            "id": log.id,
            "operation": log.operation,
            "timestamp": log.timestamp.isoformat() if log.timestamp else None,
            "old_path": log.old_path,
            "new_path": log.new_path
        })
    return result

@app.get("/api/logs")
def get_logs(db: Session = Depends(get_db)):
    """Returns a list of operation logs."""
    stmt = select(ChangeLog).order_by(ChangeLog.timestamp.desc()).limit(50)
    logs = db.scalars(stmt).all()
    
    result = []
    for log in logs:
        file_name = log.file.file_name if log.file else "Unknown"
        result.append({
            "id": log.id,
            "file_name": file_name,
            "operation": log.operation,
            "timestamp": log.timestamp.isoformat() if log.timestamp else None,
            "old_path": log.old_path,
            "new_path": log.new_path
        })
    return result

class SearchRequest(BaseModel):
    query: str

@app.post("/api/search")
def search_files(request: SearchRequest, db: Session = Depends(get_db)):
    """
    First-level retrieval: searches the memory layer (summaries) in Qdrant.
    Filters out any soft-deleted files from the SQLite index.
    """
    if not request.query.strip():
        return {"results": []}
        
    # Query more from Qdrant just in case some are deleted
    raw_results = vector_db.search(request.query, limit=15)
    
    valid_results = []
    for r in raw_results:
        stmt = select(FileIndex).where(FileIndex.id == r["file_id"], FileIndex.is_deleted == False)
        if db.scalar(stmt):
            valid_results.append(r)
        if len(valid_results) >= 5:
            break
            
    return {
        "results": valid_results
    }

class OrganizeRequest(BaseModel):
    dir_path: str
    max_categories: int = 5

@app.post("/api/directory/organize")
async def api_organize_directory(req: OrganizeRequest, db: Session = Depends(get_db)):
    """
    Direct endpoint for the UI to trigger the LLM-based semantic graph organization.
    """
    from agent.tools import execute_semantic_organization
    from agent.master_agent import deepseek_client, model_name
    
    dir_path_with_slash = req.dir_path if req.dir_path.endswith('/') else req.dir_path + '/'
    
    # 1. Gather files and their summaries/entities
    stmt = select(FileIndex).where(
        FileIndex.is_deleted == False,
        FileIndex.file_path.startswith(dir_path_with_slash)
    )
    files = db.scalars(stmt).all()
    if not files:
        return {"error": "No indexed files found to organize."}
        
    file_ids = [f.id for f in files]
    mem_stmt = select(MemoryRecord).where(MemoryRecord.file_id.in_(file_ids))
    mems = db.scalars(mem_stmt).all()
    
    mem_map = {m.file_id: m for m in mems}
    
    files_data = []
    for f in files:
        m = mem_map.get(f.id)
        if m:
            files_data.append({
                "id": f.id,
                "name": f.file_name,
                "summary": m.summary[:200] if m.summary else "",
                "entities": m.key_entities[:5] if m.key_entities else []
            })
            
    if not files_data:
        return {"error": "No memory records found for files in this directory."}
        
    # 2. Call LLM for Semantic Categorization
    system_prompt = f"""You are an expert file system organizer.
Your task is to organize the provided list of files into {req.max_categories} to {req.max_categories+3} high-level, human-friendly directory categories.
Analyze the file names, summaries, and key entities to synthesize broad, general taxonomic folders (e.g., "Engineering", "Finance", "Marketing", "Research").
Use plain text for folder names. Do NOT use emojis.

Output EXACTLY and ONLY a valid JSON object mapping each file "id" to its assigned category string.
Example:
{{
  "id_1": "Engineering",
  "id_2": "Research"
}}
Do NOT output any markdown blocks or explanations, just the raw JSON object."""

    user_prompt = json.dumps(files_data, ensure_ascii=False)
    
    try:
        response = await deepseek_client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            response_format={"type": "json_object"}
        )
        llm_output = response.choices[0].message.content
        category_map = json.loads(llm_output)
    except Exception as e:
        return {"error": f"LLM organization failed: {str(e)}"}
        
    # 3. Execute organization
    result_str = execute_semantic_organization(req.dir_path, category_map)
    return {
        "message": result_str,
        "categories": list(set(category_map.values()))
    }

scan_status = {
    "is_scanning": False,
    "current_file": "",
    "progress": 0
}

def update_status(filename, current, total):
    scan_status["current_file"] = filename
    scan_status["progress"] = int((current / total) * 100) if total > 0 else 0

def auto_scan_callback(paths):
    scan_status["is_scanning"] = True
    try:
        for p in paths:
            scan_directory(p, engine, status_callback=update_status)
    finally:
        # Guarantee the frontend's 1-second interval poller catches the 'True' state
        time.sleep(1.5)
        scan_status["is_scanning"] = False
        scan_status["current_file"] = ""

set_scan_callback(auto_scan_callback)

@app.get("/api/system/choose_folder")
def choose_folder():
    """Opens a native macOS folder picker and returns the selected paths."""
    try:
        script = '''
            tell application "Finder"
                activate
                delay 0.3
                set selectedFolders to choose folder with prompt "Please select folders to scan (hold Cmd to multi-select)" with multiple selections allowed
            end tell
            set posixPaths to {}
            repeat with i from 1 to count of selectedFolders
                set end of posixPaths to POSIX path of item i of selectedFolders
            end repeat
            set AppleScript's text item delimiters to "\\n"
            return posixPaths as text
        '''
        result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip():
            paths = [p for p in result.stdout.strip().split('\\n') if p]
            return {"paths": paths}
        return {"paths": []}
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/scan")
def start_scan(request: dict, background_tasks: BackgroundTasks):
    paths = request.get("paths", [])
    if not paths:
        return {"error": "No paths provided"}
    
    if scan_status["is_scanning"]:
        return {"error": "Scan already in progress"}
        
    def update_status(filename, current, total):
        scan_status["current_file"] = filename
        scan_status["progress"] = int((current / total) * 100) if total > 0 else 0

    def do_scan(paths):
        scan_status["is_scanning"] = True
        try:
            save_and_watch_folders(paths)
            for p in paths:
                scan_directory(p, engine, status_callback=update_status)
        finally:
            scan_status["is_scanning"] = False
            scan_status["current_file"] = ""
            
    background_tasks.add_task(do_scan, paths)
    return {"message": "Scan started"}

@app.get("/api/scan/status")
def get_scan_status():
    return scan_status
@app.get("/api/graph/schema")
def graph_schema():
    try:
        return neo4j_graph.get_schema()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Neo4j schema query failed: {str(e)}")

@app.get("/api/graph/explore")
def explore_graph(limit: int = 500):
    try:
        return neo4j_graph.explore_graph(limit=limit)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Neo4j query failed: {str(e)}")

from typing import Optional

class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None

def generate_session_title(session_id: str, first_message: str):
    from app.database import init_db, ChatSession
    from sqlalchemy.orm import Session
    from sqlalchemy import select
    from openai import OpenAI
    import os
    from dotenv import load_dotenv
    from pathlib import Path

    env_path = Path(__file__).parent.parent / ".env"
    load_dotenv(dotenv_path=env_path)
    
    try:
        client = OpenAI(
            api_key=os.getenv("DEEPSEEK_API_KEY", ""),
            base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
        )
        model_name = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
        
        resp = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": "You are an expert at summarizing. Summarize the user's message into a very short, concise title (max 5-8 words). Output ONLY the title, no quotes or prefix."},
                {"role": "user", "content": first_message}
            ],
            max_tokens=15,
            temperature=0.3
        )
        
        title = resp.choices[0].message.content.strip().strip('"').strip("'")
        if not title:
            title = first_message[:15] + "..."
            
        engine = init_db()
        with Session(engine) as session:
            chat_session = session.scalar(select(ChatSession).where(ChatSession.id == session_id))
            if chat_session:
                chat_session.title = title
                session.commit()
                print(f"Session {session_id} title updated to: {title}")
    except Exception as e:
        print(f"Title generation failed: {e}")

def compress_chat_session(session_id: str):
    from app.database import init_db, ChatSession, ChatMessage
    from sqlalchemy.orm import Session
    from sqlalchemy import select
    from openai import OpenAI
    import os
    from dotenv import load_dotenv
    from pathlib import Path

    env_path = Path(__file__).parent.parent / ".env"
    load_dotenv(dotenv_path=env_path)
    
    try:
        engine = init_db()
        with Session(engine) as session:
            chat_session = session.scalar(select(ChatSession).where(ChatSession.id == session_id))
            if not chat_session:
                return
                
            stmt = select(ChatMessage).where(ChatMessage.session_id == session_id).order_by(ChatMessage.created_at.asc())
            all_msgs = session.scalars(stmt).all()
            
            if not all_msgs:
                return
                
            current_count = len(all_msgs)
            
            text_lines = []
            if chat_session.summary:
                text_lines.append(f"PREVIOUS SUMMARY:\n{chat_session.summary}\n")
            text_lines.append("NEW CONVERSATION:")
            for m in all_msgs:
                text_lines.append(f"{m.role.upper()}: {m.content}")
                
            full_text = "\n".join(text_lines)
            
        client = OpenAI(
            api_key=os.getenv("DEEPSEEK_API_KEY", ""),
            base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
        )
        model_name = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
        
        resp = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": "You are a context compression assistant. Your task is to concisely summarize the entire conversation history provided, keeping all essential facts, user preferences, and important technical context. Output ONLY the new summary text."},
                {"role": "user", "content": full_text}
            ],
            max_tokens=500,
            temperature=0.3
        )
        
        new_summary = resp.choices[0].message.content.strip()
        
        with Session(engine) as session:
            chat_session = session.scalar(select(ChatSession).where(ChatSession.id == session_id))
            if chat_session and new_summary:
                chat_session.summary = new_summary
                chat_session.summary_msg_count = current_count
                session.commit()
                print(f"Session {session_id} compressed up to {current_count} messages.")
    except Exception as e:
        print(f"Compression failed: {e}")

@app.post("/api/agent/chat")
def agent_chat(req: ChatRequest, bg_tasks: BackgroundTasks):
    # Delay import dependencies within function to avoid circular references
    from agent.master_agent import agent as master_agent
    from agents import Runner
    from app.database import init_db, ChatSession, ChatMessage
    from sqlalchemy.orm import Session
    from sqlalchemy import select
    
    engine = init_db()
    
    try:
        with Session(engine) as session:
            # 1. Find or create Session
            chat_session = None
            is_new_session = False
            if req.session_id:
                chat_session = session.scalar(select(ChatSession).where(ChatSession.id == req.session_id))
            
            if not chat_session:
                chat_session = ChatSession(title="New Chat")
                session.add(chat_session)
                session.commit()
                session.refresh(chat_session)
                is_new_session = True
            
            # 2. Fetch history messages (max 20)
            stmt = select(ChatMessage).where(ChatMessage.session_id == chat_session.id).order_by(ChatMessage.created_at.desc()).limit(20)
            db_history = session.scalars(stmt).all()
            
            # Assemble context for Agent (needs to be reversed to chronological order)
            messages_for_agent = []
            if chat_session.summary:
                messages_for_agent.append({"role": "system", "content": f"Previous conversation memory summary: {chat_session.summary}"})
                
            for msg in reversed(db_history):
                # Adapt to OpenAI's role convention (assistant)
                role = "assistant" if msg.role == "agent" else msg.role
                messages_for_agent.append({"role": role, "content": msg.content})
            
            # Append new user message
            messages_for_agent.append({"role": "user", "content": req.message})

            # 3. Record user message in DB
            user_msg = ChatMessage(session_id=chat_session.id, role="user", content=req.message)
            session.add(user_msg)
            session.commit()

            # 4. Invoke Agent (pass full conversation)
            result = Runner.run_sync(master_agent, messages_for_agent)
            
            # 5. Record Agent response in DB
            agent_msg = ChatMessage(session_id=chat_session.id, role="agent", content=result.final_output)
            session.add(agent_msg)
            session.commit()

            # 6. Generate title in background
            if is_new_session:
                bg_tasks.add_task(generate_session_title, chat_session.id, req.message)
                
            # 7. Check if rolling compression is needed (every 10 new messages)
            from sqlalchemy import func
            total_msgs = session.scalar(select(func.count(ChatMessage.id)).where(ChatMessage.session_id == chat_session.id))
            is_compressing = False
            if total_msgs > (chat_session.summary_msg_count or 0) + 10:
                is_compressing = True
                bg_tasks.add_task(compress_chat_session, chat_session.id)

            return {
                "reply": result.final_output,
                "session_id": chat_session.id,
                "is_compressing": is_compressing
            }
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/agent/chat/history")
def get_chat_history(session_id: str):
    from app.database import init_db, ChatMessage
    from sqlalchemy.orm import Session
    from sqlalchemy import select
    
    engine = init_db()
    
    with Session(engine) as session:
        stmt = select(ChatMessage).where(ChatMessage.session_id == session_id).order_by(ChatMessage.created_at.asc())
        history = session.scalars(stmt).all()
        return [
            {
                "id": msg.id,
                "role": msg.role,
                "content": msg.content,
                "created_at": msg.created_at
            }
            for msg in history
        ]

@app.get("/api/agent/sessions")
def get_all_sessions():
    from app.database import init_db, ChatSession
    from sqlalchemy.orm import Session
    from sqlalchemy import select
    
    engine = init_db()
    with Session(engine) as session:
        stmt = select(ChatSession).order_by(ChatSession.created_at.desc())
        sessions = session.scalars(stmt).all()
        return [
            {
                "id": s.id,
                "title": s.title,
                "created_at": s.created_at
            }
            for s in sessions
        ]

if __name__ == "__main__":
    import uvicorn
    # Make sure you install uvicorn and fastapi: pip install fastapi uvicorn
    print("🚀 Starting reIndex server at http://127.0.0.1:8001")
    uvicorn.run(app, host="127.0.0.1", port=8001)
