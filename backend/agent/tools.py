import os
import json
from app import vector_db
from app.database import init_db, FileIndex, ChangeLog
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.graph_db import graph_db

# Initialize an engine for the tools
engine = init_db()

def search_knowledge_base(query: str, limit: int = 5) -> str:
    """
    Search the local vector database (Qdrant) AND the Knowledge Graph (Neo4j) for deep multi-hop reasoning.
    Returns a formatted string containing matching file summaries and graph relationships.
    
    Args:
        query: The semantic search query (e.g. 'auth logic', 'dark mode styling')
        limit: Max number of files to return (default 5)
    """
    print(f"🛠️ Tool Called: search_knowledge_base(query='{query}')")
    try:
        results = vector_db.search(query, limit=limit)
        if not results:
            return "No matching files found in the knowledge base."
        
        final_output = {"vector_documents": [], "graph_relationships": []}
        all_entities = set()
        
        with Session(engine) as session:
            for r in results:
                file_id = r["file_id"]
                stmt = select(FileIndex).where(FileIndex.id == file_id, FileIndex.is_deleted == False)
                db_record = session.scalar(stmt)
                
                if db_record:
                    final_output["vector_documents"].append({
                        "file_name": db_record.file_name,
                        "file_path": db_record.file_path,
                        "similarity_score": f"{r['score']}%",
                        "summary": r["summary"]
                    })
                    
                    # Collect entities to use as jump-off points for the Graph search ONLY if the file is active
                    for ent in r.get("key_entities", []):
                        all_entities.add(ent)
        
        # 2. Query the Graph Database using the extracted entities
        if all_entities:
            print(f"  -> Fetching Graph subgraphs for {len(all_entities)} entities...")
            graph_rels = graph_db.query_subgraph(list(all_entities), max_hops=2)
            final_output["graph_relationships"] = graph_rels
            
        return json.dumps(final_output, ensure_ascii=False, indent=2)
    except Exception as e:
        return f"Error searching knowledge base: {str(e)}"

def read_local_file(file_path: str) -> str:
    """
    Read the physical content of a local file. Use this when you need to inspect the actual code or text.
    
    Args:
        file_path: The absolute path to the file.
    """
    print(f"🛠️ Tool Called: read_local_file(file_path='{file_path}')")
    if not os.path.exists(file_path):
        return f"Error: File not found at {file_path}"
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
            return content
    except Exception as e:
        return f"Error reading file {file_path}: {str(e)}"

def rename_local_file(old_path: str, new_name: str) -> str:
    """
    Rename a physical file on the disk and update its record in the database.
    Use this when you need to rename a file based on its content or user instructions.
    
    Args:
        old_path: The absolute path to the existing file.
        new_name: The new filename (e.g. 'auth_logic_v2.py'), without the directory path.
    """
    print(f"🛠️ Tool Called: rename_local_file(old_path='{old_path}', new_name='{new_name}')")
    if not os.path.exists(old_path):
        return f"Error: File not found at {old_path}"
    
    dir_name = os.path.dirname(old_path)
    new_path = os.path.join(dir_name, new_name)
    
    if os.path.exists(new_path):
        return f"Error: A file already exists at {new_path}"
    
    try:
        # 1. Rename physical file
        os.rename(old_path, new_path)
        
        # 2. Update SQLite database and add change log
        with Session(engine) as session:
            stmt = select(FileIndex).where(FileIndex.file_path == old_path)
            db_record = session.scalar(stmt)
            
            if db_record:
                db_record.file_name = new_name
                db_record.file_path = new_path
                db_record.last_modified = os.path.getmtime(new_path)
                
                # Add audit log
                log = ChangeLog(
                    file_id=db_record.id,
                    operation="RENAMED",
                    old_path=old_path,
                    new_path=new_path
                )
                session.add(log)
                session.commit()
                return f"Success: Renamed file to {new_name}. Database and ChangeLog updated."
            else:
                return f"Success: Renamed physical file to {new_name}, but no database record was found."
    except Exception as e:
        return f"Error renaming file: {str(e)}"



def execute_semantic_organization(dir_path: str, file_category_map: dict) -> str:
    """
    Physically organizes files based on a direct semantic mapping provided by an LLM.
    
    Args:
        dir_path: The absolute path to the directory.
        file_category_map: A dict mapping file ID to category name, e.g., {"id_1": "📁 HR Personnel"}
    """
    import shutil
    if not os.path.exists(dir_path):
        return f"Error: Directory {dir_path} does not exist."
        
    dir_path_with_slash = dir_path if dir_path.endswith('/') else dir_path + '/'
    
    try:
        with Session(engine) as session:
            stmt = select(FileIndex).where(FileIndex.id.in_(list(file_category_map.keys())))
            files = session.scalars(stmt).all()
            
            results = []
            
            for f in files:
                cat_name = file_category_map.get(f.id)
                if not cat_name:
                    continue
                    
                # Clean up category name (remove weird characters if any)
                safe_cat = "".join(c for c in cat_name if c not in r'\/:*?"<>|')
                cat_dir = os.path.join(dir_path, safe_cat)
                os.makedirs(cat_dir, exist_ok=True)
                
                old_path = f.file_path
                new_path = os.path.join(cat_dir, f.file_name)
                
                if old_path != new_path:
                    # Handle collision
                    if os.path.exists(new_path):
                        base, ext = os.path.splitext(f.file_name)
                        f.file_name = f"{base}_{f.id[:4]}{ext}"
                        new_path = os.path.join(cat_dir, f.file_name)
                        
                    shutil.move(old_path, new_path)
                    f.file_path = new_path
                    log = ChangeLog(file_id=f.id, operation="MOVED_SEMANTIC", old_path=old_path, new_path=new_path)
                    session.add(log)
                    results.append(f"Moved -> {safe_cat}/{f.file_name}")
                    
            session.commit()
            
            # Clean up any empty directories left behind
            cleanup_results = []
            for root, dirs, files_in_dir in os.walk(dir_path, topdown=False):
                for d in dirs:
                    folder_path = os.path.join(root, d)
                    try:
                        if not os.listdir(folder_path): # Check if directory is empty
                            os.rmdir(folder_path)
                            cleanup_results.append(f"Removed empty folder: {d}")
                    except OSError:
                        pass # Directory not empty or permission denied
                        
            return "\n".join(results) + ("\n\nCleanup:\n" + "\n".join(cleanup_results) if cleanup_results else "")
    except Exception as e:
        return f"Error executing semantic organization: {str(e)}"
