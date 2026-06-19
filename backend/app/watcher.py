import time
import threading
import os
import json
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from scripts.scanner import scan_directory
from app.database import init_db

# Global observer
_observer = None
_watched_paths = set()

# Debounce state
_debounce_timers = {}
engine = init_db()

_scan_callback = None

def set_scan_callback(cb):
    global _scan_callback
    _scan_callback = cb

def trigger_scan(path):
    print(f"\n👀 [Watchdog] Detected file change, performing silent incremental indexing: {path}")
    try:
        if _scan_callback:
            _scan_callback([path])
        else:
            scan_directory(path, engine)
    except Exception as e:
        print(f"Error during auto-scan: {e}")

class AutoScanHandler(FileSystemEventHandler):
    def __init__(self, root_path):
        self.root_path = root_path
        
    def on_any_event(self, event):
        # Ignore directory events or hidden files
        if event.is_directory:
            return
        basename = os.path.basename(event.src_path)
        if basename.startswith('.'):
            return
            
        # Debounce: if an event happens, cancel the old timer and start a new 2-second timer
        if self.root_path in _debounce_timers:
            _debounce_timers[self.root_path].cancel()
            
        timer = threading.Timer(2.0, trigger_scan, args=[self.root_path])
        _debounce_timers[self.root_path] = timer
        timer.start()

def start_watching(path: str):
    global _observer
    if not os.path.exists(path):
        return
        
    abs_path = str(Path(path).resolve())
    if abs_path in _watched_paths:
        return
        
    if _observer is None:
        _observer = Observer()
        _observer.start()
        
    event_handler = AutoScanHandler(abs_path)
    _observer.schedule(event_handler, abs_path, recursive=True)
    _watched_paths.add(abs_path)
    print(f"👁️ [Watchdog] Started real-time folder monitoring: {abs_path}")

TRACKED_CONFIG_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "tracked_folders.json")

def load_and_watch_saved_folders():
    if os.path.exists(TRACKED_CONFIG_FILE):
        try:
            with open(TRACKED_CONFIG_FILE, 'r') as f:
                paths = json.load(f)
                for p in paths:
                    start_watching(p)
        except Exception as e:
            print(f"Error loading watched folders: {e}")

def save_and_watch_folders(paths):
    current_paths = []
    if os.path.exists(TRACKED_CONFIG_FILE):
        try:
            with open(TRACKED_CONFIG_FILE, 'r') as f:
                current_paths = json.load(f)
        except Exception:
            pass
            
    for p in paths:
        abs_p = str(Path(p).resolve())
        if abs_p not in current_paths:
            current_paths.append(abs_p)
        start_watching(abs_p)
        
    # Ensure data dir exists
    os.makedirs(os.path.dirname(TRACKED_CONFIG_FILE), exist_ok=True)
    with open(TRACKED_CONFIG_FILE, 'w') as f:
        json.dump(current_paths, f)
