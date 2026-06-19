import os
import hashlib
from pathlib import Path
from sqlalchemy.orm import Session
from sqlalchemy import select
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.database import init_db, FileIndex, ChangeLog, MemoryRecord
from app.parser import parse_file
from app.llm_connector import generate_summary_and_entities, extract_triplets
from app.graph_db import graph_db
from app import vector_db

def calculate_file_hash(file_path: str, chunk_size: int = 8192) -> str:
    """
    Calculates the MD5 hash of a file's content.
    """
    md5_hash = hashlib.md5()
    try:
        with open(file_path, "rb") as f:
            while chunk := f.read(chunk_size):
                md5_hash.update(chunk)
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
        return ""
    return md5_hash.hexdigest()

def process_file_memory(session: Session, file_record: FileIndex):
    """
    Extracts text, generates summary via LLM, and creates a MemoryRecord.
    """
    # Guard: skip if file is marked as deleted
    if file_record.is_deleted:
        print(f"  -> Skipped '{file_record.file_name}' (file is deleted)")
        return

    # Guard: skip if MemoryRecord already exists (avoid re-processing)
    stmt_existing = select(MemoryRecord).where(MemoryRecord.file_id == file_record.id)
    existing_mem = session.scalar(stmt_existing)
    if existing_mem:
        print(f"  -> Skipped '{file_record.file_name}' (memory already exists)")
        return

    # 1. Parse text from the physical file
    content = parse_file(file_record.file_path)
    if not content.strip():
        print(f"  -> Skipped memory generation for '{file_record.file_name}' (No readable text found)")
        return
    
    # 2. Call LLM to understand the text
    print(f"  -> Generating memory for '{file_record.file_name}'...")
    llm_result = generate_summary_and_entities(content)
    
    # 3. Save to MemoryRecord
    summary = llm_result.get("summary", "")
    key_entities = llm_result.get("key_entities", [])
    
    memory = MemoryRecord(
        file_id=file_record.id,
        content_text=content,  # Store full text for second-level retrieval (trace back to source)
        summary=summary,
        key_entities=key_entities
    )
    session.add(memory)
    
    # 4. Save summary vector to Qdrant (first-level: memory layer)
    vector_db.upsert_file_summary(str(file_record.id), file_record.file_name, summary, key_entities)
    
    # 5. Extract Triplets and save to Neo4j (second-level: graph layer)
    print(f"  -> Extracting GraphRAG triplets for '{file_record.file_name}'...")
    triplets = extract_triplets(content)
    if triplets:
        graph_db.add_triplets(str(file_record.id), triplets)
        print(f"  -> {len(triplets)} triplets saved to Neo4j.")
    
    print(f"  -> Memory & summary vector & graph saved successfully.")

def scan_directory(directory_path: str, db_engine, status_callback=None):
    """
    Scans a directory, updates the FileIndex, writes to ChangeLog, 
    and generates MemoryRecords for new or updated files.
    """
    target_dir = Path(directory_path)
    if not target_dir.exists() or not target_dir.is_dir():
        print(f"Error: Directory {directory_path} does not exist or is not a directory.")
        return

    # Pre-calculate total files for progress bar
    all_files_to_scan = []
    for root, dirs, files in os.walk(target_dir):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d != '__pycache__']
        for filename in files:
            if not filename.startswith('.') and not os.path.islink(os.path.join(root, filename)):
                all_files_to_scan.append((root, filename))
                
    total_files = len(all_files_to_scan)
    scanned_file_paths = set()
    current_count = 0

    with Session(db_engine) as session:
        # 1. Process files
        for root, filename in all_files_to_scan:
            current_count += 1
            if status_callback:
                status_callback(filename, current_count, total_files)

            file_path = os.path.join(root, filename)
            abs_file_path = str(Path(file_path).resolve())
            scanned_file_paths.add(abs_file_path)

            try:
                file_stat = os.stat(abs_file_path)
            except FileNotFoundError:
                continue 

            file_size = file_stat.st_size
            last_modified = file_stat.st_mtime
            file_extension = Path(abs_file_path).suffix.lower()

            stmt = select(FileIndex).where(FileIndex.file_path == abs_file_path)
            existing_record = session.scalar(stmt)

            if existing_record is None:
                # Case A: New file
                content_hash = calculate_file_hash(abs_file_path)
                new_file = FileIndex(
                    file_name=filename,
                    file_path=abs_file_path,
                    file_type=file_extension,
                    file_size=file_size,
                    last_modified=last_modified,
                    content_hash=content_hash,
                    is_deleted=False
                )
                session.add(new_file)
                session.flush() # Ensure new_file gets its primary key UUID
                
                log = ChangeLog(file=new_file, operation="CREATED", new_path=abs_file_path)
                session.add(log)
                print(f"Added: {filename}")
                
                # Generate AI memory for the new file
                process_file_memory(session, new_file)

            else:
                if existing_record.is_deleted:
                    # Case C: Restored file
                    existing_record.is_deleted = False
                    content_hash = calculate_file_hash(abs_file_path)
                    
                    if existing_record.content_hash != content_hash:
                        existing_record.content_hash = content_hash
                        existing_record.last_modified = last_modified
                        existing_record.file_size = file_size
                        
                        # Clean up old obsolete memory
                        stmt_mem = select(MemoryRecord).where(MemoryRecord.file_id == existing_record.id)
                        old_mems = session.scalars(stmt_mem).all()
                        for om in old_mems:
                            session.delete(om)
                        session.flush()

                        # Clean up old vectors & graph
                        vector_db.delete_file_vectors(str(existing_record.id))
                        graph_db.delete_file_triplets(str(existing_record.id))

                        print(f"Restored & Updated: {filename}")
                        process_file_memory(session, existing_record)
                    else:
                        print(f"Restored: {filename}")
                        
                    log = ChangeLog(file=existing_record, operation="RESTORED", new_path=abs_file_path)
                    session.add(log)

                else:
                    # Case B: Modified file
                    if existing_record.last_modified != last_modified:
                        content_hash = calculate_file_hash(abs_file_path)
                        
                        if existing_record.content_hash != content_hash:
                            existing_record.content_hash = content_hash
                            existing_record.last_modified = last_modified
                            existing_record.file_size = file_size
                            
                            # Clean up old obsolete memory before generating new one
                            stmt_mem = select(MemoryRecord).where(MemoryRecord.file_id == existing_record.id)
                            old_mems = session.scalars(stmt_mem).all()
                            for om in old_mems:
                                session.delete(om)
                            session.flush()
                            
                            # Clean up old vectors & graph
                            vector_db.delete_file_vectors(str(existing_record.id))
                            graph_db.delete_file_triplets(str(existing_record.id))
                            
                            log = ChangeLog(file=existing_record, operation="UPDATED", old_path=abs_file_path, new_path=abs_file_path)
                            session.add(log)
                            print(f"Updated: {filename}")
                            
                            # Regenerate AI memory for the updated file
                            process_file_memory(session, existing_record)

        # 2. Check for deleted files
        stmt = select(FileIndex).where(FileIndex.is_deleted == False)
        all_active_files = session.scalars(stmt).all()

        for record in all_active_files:
            if record.file_path.startswith(str(target_dir.resolve())):
                if record.file_path not in scanned_file_paths:
                    record.is_deleted = True
                    log = ChangeLog(file=record, operation="DELETED", old_path=record.file_path)
                    session.add(log)
                    
                    # Clean up vectors & graph when file is deleted
                    vector_db.delete_file_vectors(str(record.id))
                    graph_db.delete_file_triplets(str(record.id))
                    
                    print(f"Deleted: {record.file_name}")

        session.commit()
        print("Scan and memory generation completed successfully.")


