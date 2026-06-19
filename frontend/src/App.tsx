import React, { useEffect, useState, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import NativeGraph from './NativeGraph';
import './index.css';

export default function App() {
  const [files, setFiles] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'info' | 'actions' | 'manage'>('info');
  
  // Organization UI state
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [organizeResult, setOrganizeResult] = useState('');
  
  // View mode
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [gridCurrentPath, setGridCurrentPath] = useState<string>('');
  
  // Ref for auto-scrolling chat
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [selectedFile, setSelectedFile] = useState<any>(null);
  const [selectedFileDetail, setSelectedFileDetail] = useState<any>(null);
  const [selectedFileLogs, setSelectedFileLogs] = useState<any[]>([]);
  const [scanStatus, setScanStatus] = useState({ is_scanning: false, current_file: "", progress: 0 });
  const [checkedFileIds, setCheckedFileIds] = useState<Set<string>>(new Set());
  const [currentFolder, setCurrentFolder] = useState<'active' | 'trash' | 'graph'>('active');

  // Agent Chat States
  const [sessionId, setSessionId] = useState<string | null>(localStorage.getItem('agentSessionId'));
  const [chatInput, setChatInput] = useState('');
  const [chatHistory, setChatHistory] = useState<{role: 'user' | 'agent', content: string}[]>([]);
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [sessionsList, setSessionsList] = useState<any[]>([]);

  // Global Search States
  const [showAiSearch, setShowAiSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // UI Customization States
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(320);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const [indexMessage, setIndexMessage] = useState<string | null>(null);


  // Preview Modal States
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewContent, setPreviewContent] = useState('');
  const [previewTitle, setPreviewTitle] = useState('');

  const handleDoubleClickFile = (f: any) => {
    fetch(`http://127.0.0.1:8001/api/files/${f.id}/source`)
      .then(res => {
         if (!res.ok) throw new Error('No source available');
         return res.json();
      })
      .then(data => {
         setPreviewTitle(f.file_name);
         setPreviewContent(data.content);
         setShowPreviewModal(true);
      })
      .catch(err => {
         setPreviewTitle(f.file_name);
         setPreviewContent("Preview unavailable or no text record for this file.");
         setShowPreviewModal(true);
      });
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = startX.current - e.clientX;
      const newWidth = startWidth.current + delta;
      if (newWidth >= 200 && newWidth <= 800) {
        setPreviewWidth(newWidth);
      }
    };
    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false;
        document.body.style.cursor = 'default';
      }
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    if (sessionId) {
      fetch(`http://127.0.0.1:8001/api/agent/chat/history?session_id=${sessionId}`)
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) {
            const history: {role: 'user' | 'agent', content: string}[] = data.map((msg: any) => ({
              role: msg.role === 'assistant' ? 'agent' : (msg.role as 'user' | 'agent'),
              content: msg.content
            }));
            setChatHistory(history);
          }
        })
        .catch(err => console.error("Failed to load chat history", err));
    }
  }, [sessionId]);

  const fetchFiles = (folder = currentFolder) => {
    fetch(`http://127.0.0.1:8001/api/files?status=${folder}`)
      .then(res => res.json())
      .then(data => {
        setFiles(data);
        if (data.length > 0) {
          handleSelectFile(data[0]);
        } else {
          setSelectedFile(null);
          setSelectedFileDetail(null);
        }
      })
      .catch(err => console.error(err));
  };

  const batchAction = async (action: 'trash' | 'restore' | 'delete') => {
    if (checkedFileIds.size === 0) return;
    const endpoint = action === 'trash' ? 'batch-trash' : (action === 'restore' ? 'batch-restore' : 'batch-delete-permanent');
    try {
      await fetch(`http://127.0.0.1:8001/api/files/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_ids: Array.from(checkedFileIds) })
      });
      setCheckedFileIds(new Set());
      fetchFiles();
    } catch(e) { console.error(e); }
  };

  const singleAction = async (action: 'trash' | 'restore' | 'delete') => {
    if (!selectedFile) return;
    const endpoint = action === 'trash' ? 'batch-trash' : (action === 'restore' ? 'batch-restore' : 'batch-delete-permanent');
    try {
      await fetch(`http://127.0.0.1:8001/api/files/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_ids: [selectedFile.id] })
      });
      fetchFiles();
    } catch(e) { console.error(e); }
  };

  const handleSelectFile = (f: any) => {
    setSelectedFile(f);
    fetch(`http://127.0.0.1:8001/api/files/${f.id}`)
      .then(res => res.json())
      .then(data => setSelectedFileDetail(data))
      .catch(err => console.error(err));

    fetch(`http://127.0.0.1:8001/api/files/${f.id}/logs`)
      .then(res => res.json())
      .then(data => setSelectedFileLogs(data))
      .catch(err => console.error(err));
  };

  // --- FILE TREE LOGIC ---
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectedFolderNode, setSelectedFolderNode] = useState<string | null>(null);

  const commonPrefix = useMemo(() => {
    if (!files || files.length === 0) return '';
    const paths = files.map(f => f.file_path);
    if (paths.length === 1) return paths[0].substring(0, paths[0].lastIndexOf('/') + 1);
    const splitPaths = paths.map(p => p.split('/'));
    let prefix = [];
    for (let i = 0; i < splitPaths[0].length; i++) {
      const char = splitPaths[0][i];
      if (splitPaths.every(p => p[i] === char)) {
        prefix.push(char);
      } else {
        break;
      }
    }
    return prefix.join('/') + '/';
  }, [files]);

  useEffect(() => {
    if (commonPrefix && expandedFolders.size === 0) {
       setExpandedFolders(new Set([commonPrefix.replace(/\/$/, '')]));
       if (!gridCurrentPath) setGridCurrentPath(commonPrefix.replace(/\/$/, ''));
    }
  }, [commonPrefix]);

  const fileTree = useMemo(() => {
    const root = { name: '📦 Workspace', path: commonPrefix, type: 'folder', children: {} as any };
    files.forEach(f => {
      let relPath = f.file_path;
      if (f.file_path.startsWith(commonPrefix)) {
        relPath = f.file_path.substring(commonPrefix.length);
      }
      const parts = relPath.split('/');
      let current = root;
      let currentPath = commonPrefix.replace(/\/$/, '');
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath += '/' + parts[i];
        if (!current.children[parts[i]]) {
          current.children[parts[i]] = { name: parts[i], path: currentPath, type: 'folder', children: {} };
        }
        current = current.children[parts[i]];
      }
      const fileName = parts[parts.length - 1];
      current.children[fileName] = { name: fileName, path: f.file_path, type: 'file', fileData: f };
    });
    return root;
  }, [files, commonPrefix]);

  const toggleFolder = (path: string, e: any) => {
    e.stopPropagation();
    const newSet = new Set(expandedFolders);
    if (newSet.has(path)) newSet.delete(path);
    else newSet.add(path);
    setExpandedFolders(newSet);
  };

  const handleSelectFolder = (path: string, e: any) => {
    e.stopPropagation();
    setSelectedFolderNode(path);
    setSelectedFile({
       is_folder: true,
       file_path: path + '/dummy.txt',
       file_name: path.split('/').pop(),
       id: 'folder_pseudo_id',
       file_size: 0,
       last_modified: Date.now() / 1000
    });
    setSelectedFileDetail({
       memories: [{summary: `Currently selected directory: ${path}\nThis directory will serve as context for Agent chat and organization.`, key_entities: ['Directory Context']}],
       change_logs: []
    });
    setSelectedFileLogs([]);
  };

  const renderTree = (node: any, depth: number): any => {
    if (node.type === 'folder') {
      const isExpanded = expandedFolders.has(node.path);
      const isSelected = selectedFolderNode === node.path && selectedFile?.is_folder;
      
      return (
        <div key={node.path}>
          <div 
            className={`file-row ${isSelected ? 'selected' : ''}`}
            style={{ paddingLeft: `${depth * 20 + 10}px`, fontWeight: 'bold' }}
            onClick={(e) => { toggleFolder(node.path, e); handleSelectFolder(node.path, e); }}
          >
            <div style={{width: '24px', cursor: 'pointer', textAlign: 'center', opacity: 0.7}} onClick={(e) => toggleFolder(node.path, e)}>
               {isExpanded ? '▼' : '▶'}
            </div>
            <div className="file-icon" style={{marginRight: '8px'}}>📁</div>
            <div className="filename" style={{flex: 1}}>{node.name.replace(/^📁\s*/, '')}</div>
            <div className="file-date"></div>
            <div className="file-size"></div>
            <div></div>
          </div>
          {isExpanded && Object.values(node.children).map((child: any) => renderTree(child, depth + 1))}
        </div>
      );
    } else {
      const f = node.fileData;
      let icon = '📄';
      const t = (f.file_type || '').toLowerCase();
      if (t === '.pdf') icon = '📄';
      else if (t === '.docx' || t === '.doc') icon = '📋';
      else if (t === '.xlsx' || t === '.xls') icon = '📊';
      else if (t === '.md') icon = '📝';
      else if (t === '.png' || t === '.jpg') icon = '🖼️';
      
      const dateStr = new Date(f.last_modified * 1000).toLocaleDateString();
      let sizeStr = f.file_size + ' B';
      if (f.file_size > 1024 * 1024) sizeStr = (f.file_size / (1024 * 1024)).toFixed(1) + ' MB';
      else if (f.file_size > 1024) sizeStr = (f.file_size / 1024).toFixed(0) + ' KB';
      
      const isSelected = selectedFile?.id === f.id && !selectedFile?.is_folder;

      return (
        <div key={f.id} 
          className={`file-row ${isSelected ? 'selected' : ''}`} 
          style={{ paddingLeft: `${depth * 20 + 34}px` }}
          onClick={(e) => { e.stopPropagation(); handleSelectFile(f); setSelectedFolderNode(null); }}
          onDoubleClick={(e) => { e.stopPropagation(); handleDoubleClickFile(f); }}
        >
          <div style={{display:'flex', alignItems:'center', justifyContent:'center', width: '24px'}} onClick={(e) => e.stopPropagation()}>
            <div 
              className={`custom-checkbox ${checkedFileIds.has(f.id) ? 'checked' : ''}`}
              onClick={() => {
                const newSet = new Set(checkedFileIds);
                if (checkedFileIds.has(f.id)) newSet.delete(f.id);
                else newSet.add(f.id);
                setCheckedFileIds(newSet);
              }}
            >
              {checkedFileIds.has(f.id) && <svg viewBox="0 0 12 12" width="10" height="10" fill="white"><path d="M4.5 9L1.5 6l1-1 2 2 5-5 1 1-6 6z"/></svg>}
            </div>
          </div>
          <div className="file-icon" style={{marginRight: '8px'}}>{icon}</div>
          <div className="filename">{f.file_name}</div>
          <div className="file-date">{dateStr}</div>
          <div className="file-size">{sizeStr}</div>
          <div>
            <span className={`mem-badge mem-${f.mem_status || 'none'}`}>
              {f.mem_status === 'full' ? '● Full' : f.mem_status === 'partial' ? '◐ Partial' : '○ Pending'}
            </span>
          </div>
        </div>
      );
    }
  };

  const getTreeNodeByPath = (path: string) => {
    if (!path || path === commonPrefix || path === commonPrefix.replace(/\/$/, '')) return fileTree;
    let relPath = path;
    if (path.startsWith(commonPrefix)) {
       relPath = path.substring(commonPrefix.length);
    }
    const parts = relPath.split('/').filter(Boolean);
    let current = fileTree;
    for (const p of parts) {
      if (current.children[p]) current = current.children[p];
      else break;
    }
    return current;
  };

  const renderGrid = () => {
    const currentNode = getTreeNodeByPath(gridCurrentPath);
    if (!currentNode || !currentNode.children) return null;
    
    const childrenNodes = Object.values(currentNode.children).sort((a: any, b: any) => {
       if (a.type === 'folder' && b.type !== 'folder') return -1;
       if (a.type !== 'folder' && b.type === 'folder') return 1;
       return a.name.localeCompare(b.name);
    });

    return (
       <div className="file-grid">
         {childrenNodes.map((child: any) => {
            if (child.type === 'folder') {
               return (
                 <div key={child.path} 
                   className={`file-card ${selectedFolderNode === child.path && selectedFile?.is_folder ? 'selected' : ''}`} 
                   onClick={(e) => { e.stopPropagation(); handleSelectFolder(child.path, e); }}
                   onDoubleClick={(e) => { e.stopPropagation(); setGridCurrentPath(child.path); }}
                 >
                    <div className="file-card-icon" style={{opacity: 0.9}}>📁</div>
                    <div className="file-card-name" title={child.name}>{child.name.replace(/^📁\s*/, '')}</div>
                 </div>
               );
            } else {
               const f = child.fileData;
               let icon = '📄';
               const t = (f.file_type || '').toLowerCase();
               if (t === '.pdf') icon = '📄';
               else if (t === '.docx' || t === '.doc') icon = '📋';
               else if (t === '.xlsx' || t === '.xls') icon = '📊';
               else if (t === '.md') icon = '📝';
               else if (t === '.png' || t === '.jpg') icon = '🖼️';
               
               const isSelected = selectedFile?.id === f.id && !selectedFile?.is_folder;
               
               return (
                 <div key={f.id} 
                   className={`file-card ${isSelected ? 'selected' : ''}`} 
                   onClick={(e) => { e.stopPropagation(); handleSelectFile(f); setSelectedFolderNode(null); }}
                   onDoubleClick={(e) => { e.stopPropagation(); handleDoubleClickFile(f); }}
                 >
                    <div className="file-card-icon">{icon}</div>
                    <div className="file-card-name" title={f.file_name}>{f.file_name}</div>
                 </div>
               )
            }
         })}
       </div>
    );
  };
  // --- END FILE TREE LOGIC ---

  const sendChatMessage = async () => {
    if (!chatInput.trim() || isAgentTyping) return;
    const msg = chatInput.trim();
    const msgContext = selectedFile?.is_folder ? `[User is in directory context: ${selectedFile.file_path.replace('/dummy.txt', '')}] ` + msg : msg;
    setChatInput('');
    setChatHistory(prev => [...prev, {role: 'user', content: msg}]);
    setIsAgentTyping(true);
    
    try {
      const res = await fetch('http://127.0.0.1:8001/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msgContext, session_id: sessionId })
      });
      const data = await res.json();

      if (data.session_id && data.session_id !== sessionId) {
        setSessionId(data.session_id);
        localStorage.setItem('agentSessionId', data.session_id);
      }

      if (data.reply) {
        setChatHistory(prev => [...prev, {role: 'agent', content: data.reply}]);
      } else {
        setChatHistory(prev => [...prev, {role: 'agent', content: "Error: " + data.error}]);
      }
    } catch (e: any) {
      setChatHistory(prev => [...prev, {role: 'agent', content: "Network error: " + e.message}]);
    } finally {
      setIsAgentTyping(false);
      // Regardless of the Agent's reply, force refresh the file list to ensure UI and DB consistency
      fetchFiles(currentFolder);
      // If a file is currently selected, refresh its details/logs too
      if (selectedFile) {
        handleSelectFile(selectedFile);
      }
    }
  };

  // Fetch real data from your Python backend
  useEffect(() => {
    fetchFiles(currentFolder);
    setCheckedFileIds(new Set());
  }, [currentFolder]);

  // Fetch scan status periodically
  const previousScanningRef = useRef(scanStatus.is_scanning);

  useEffect(() => {
    const interval = setInterval(() => {
      fetch('http://127.0.0.1:8001/api/scan/status')
        .then(res => res.json())
        .then(data => {
          setScanStatus(data);
        })
        .catch(err => console.error(err));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // When scanning finishes, auto-refresh the file list!
  useEffect(() => {
    if (previousScanningRef.current === true && scanStatus.is_scanning === false) {
      fetchFiles(currentFolder);
    }
    previousScanningRef.current = scanStatus.is_scanning;
  }, [scanStatus.is_scanning, currentFolder]);

  const triggerIndexDialog = async () => {
    setIndexMessage('Opening folder picker...');
    try {
      const res = await fetch('http://127.0.0.1:8001/api/system/choose_folder');
      const data = await res.json();
      if (data.error) {
        setIndexMessage('Error: ' + data.error);
        setTimeout(() => setIndexMessage(null), 4000);
        return;
      }
      if (data.paths && data.paths.length > 0) {
        setIndexMessage(`Scanning ${data.paths.length} folder(s)...`);
        await fetch('http://127.0.0.1:8001/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: data.paths })
        });
        setIndexMessage('Scan started in background');
        fetchFiles(currentFolder);
      } else {
        setIndexMessage(null);
      }
    } catch (e) {
      setIndexMessage('Failed to connect to backend (http://127.0.0.1:8001)');
    }
    setTimeout(() => setIndexMessage(null), 4000);
  };

  // Keyboard Shortcut & Search Logic
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowAiSearch(prev => !prev);
      }
      if (e.key === 'Escape') {
        setShowAiSearch(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await fetch('http://127.0.0.1:8001/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchQuery })
        });
        const data = await res.json();
        setSearchResults(data.results || []);
      } catch (e) {
        console.error("Search failed", e);
      } finally {
        setIsSearching(false);
      }
    }, 300); // 300ms debounce
    return () => clearTimeout(timer);
  }, [searchQuery]);

  return (
    <>
      <div className={`window ${isFullscreen ? 'fullscreen' : ''}`} id="window">

  
  <div className="titlebar">
    <div className="traffic-lights">
      <div className="tl tl-close" data-icon="✕"></div>
      <div className="tl tl-min" data-icon="−"></div>
      <div className="tl tl-max" data-icon="⊕" onClick={() => setIsFullscreen(!isFullscreen)}></div>
    </div>

    <div className="nav-btns">
      <button className="nav-btn" title="Back">‹</button>
      <button className="nav-btn" title="Forward">›</button>
    </div>

    <div className="search-bar" id="searchBar" onClick={() => setShowAiSearch(true)} style={{cursor: 'pointer'}}>
      <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
      <input className="search-input" placeholder="Search files using natural language..." readOnly style={{pointerEvents: 'none'}} />
      <span className="search-hint">⌘K</span>
    </div>

    <div className="toolbar-right">
      <button className={`view-btn ${viewMode === 'list' ? 'active' : ''}`} onClick={() => setViewMode('list')}>
        <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12"><rect x="0" y="0" width="5" height="3" rx="1"/><rect x="7" y="0" width="5" height="3" rx="1"/><rect x="0" y="4.5" width="5" height="3" rx="1"/><rect x="7" y="4.5" width="5" height="3" rx="1"/><rect x="0" y="9" width="5" height="3" rx="1"/><rect x="7" y="9" width="5" height="3" rx="1"/></svg>
        List
      </button>
      <button className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`} onClick={() => setViewMode('grid')}>
        <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12"><rect x="0" y="0" width="5" height="5" rx="1"/><rect x="7" y="0" width="5" height="5" rx="1"/><rect x="0" y="7" width="5" height="5" rx="1"/><rect x="7" y="7" width="5" height="5" rx="1"/></svg>
        Icons
      </button>
      <button className="view-btn" onClick={triggerIndexDialog}>
        <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
        Index
      </button>
      {indexMessage && (
        <span style={{
          fontSize: '11px', color: 'var(--text-secondary)', marginLeft: '8px',
          maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        }}>
          {indexMessage}
        </span>
      )}
    </div>
  </div>

  
  <div className="body">

    
    <div className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-label">Organization</div>
        <div className={`sidebar-item ${currentFolder === 'active' ? 'active' : ''}`} onClick={() => setCurrentFolder('active')}>
          <span className="icon">📦</span> Workspace
        </div>
        <div className="sidebar-item disabled">
          <span className="icon">👥</span> Shared
          <span className="badge-beta">Soon</span>
        </div>
        <div className={`sidebar-item ${currentFolder === 'trash' ? 'active' : ''}`} onClick={() => setCurrentFolder('trash')}>
          <span className="icon">🗑️</span> Trash
        </div>
      </div>

      <div className="sidebar-divider"></div>

      <div className="sidebar-section">
        <div className="sidebar-label">Intelligence</div>
        <div className={`sidebar-item ${currentFolder === 'graph' ? 'active' : ''}`} onClick={() => setCurrentFolder('graph')}>
          <span className="icon" style={{color: '#3b82f6'}}>🕸️</span> Knowledge Graph
        </div>
        <div className="sidebar-item disabled">
          <span className="icon">🧠</span> Smart Collections
          <span className="badge-beta">Soon</span>
        </div>
      </div>

      <div className="sidebar-divider"></div>

      <div className="sidebar-section">
        <div className="sidebar-label">Memory Status</div>
        <div className="sidebar-item" style={{cursor: 'default'}}>
          <span className="icon" style={{color:'var(--accent-green)'}}>●</span> Fully Indexed
          <span className="badge">{files.filter(f => f.mem_status === 'full').length}</span>
        </div>
        <div className="sidebar-item" style={{cursor: 'default'}}>
          <span className="icon" style={{color:'var(--accent-amber)'}}>◐</span> Partially Indexed
          <span className="badge">{files.filter(f => f.mem_status === 'partial').length}</span>
        </div>
      </div>

      
      {scanStatus.is_scanning && (
        <div className="index-status">
          <div className="index-status-row">
            <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
              <div className="index-dot"></div>
              <span>Indexing...</span>
            </div>
            <span style={{color:'var(--text-tertiary)'}}>Scanning</span>
          </div>
          <div style={{fontSize:'10px',color:'var(--text-tertiary)',marginBottom:'4px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
            {scanStatus.current_file}
          </div>
          <div className="index-bar"><div className="index-bar-fill" style={{width: '100%', transition: 'all 0.3s'}}></div></div>
        </div>
      )}
    </div>

    {currentFolder === 'graph' ? (
      <NativeGraph />
    ) : (
      <>
        <div className="file-list">
          <div className="path-bar">
            {currentFolder === 'trash' ? (
              <span className="path-seg current">🗑️ Trash</span>
            ) : (
              <>
                <span className={`path-seg ${!gridCurrentPath || gridCurrentPath === commonPrefix.replace(/\/$/, '') ? 'current' : ''}`} onClick={() => {if(viewMode==='grid') setGridCurrentPath(commonPrefix.replace(/\/$/, ''))}}>📦 Workspace</span>
                
                {viewMode === 'grid' && gridCurrentPath && gridCurrentPath !== commonPrefix.replace(/\/$/, '') && (
                  <>
                     {(() => {
                       const rel = gridCurrentPath.startsWith(commonPrefix) ? gridCurrentPath.substring(commonPrefix.length) : gridCurrentPath;
                       const parts = rel.split('/').filter(Boolean);
                       return parts.map((seg, idx) => {
                         let targetPath = commonPrefix.replace(/\/$/, '');
                         for(let i=0; i<=idx; i++) targetPath += '/' + parts[i];
                         const isLast = idx === parts.length - 1;
                         return (
                           <React.Fragment key={idx}>
                             <span className="path-sep">›</span>
                             <span className={`path-seg ${isLast ? 'current' : ''}`} onClick={() => setGridCurrentPath(targetPath)}>
                               {seg}
                             </span>
                           </React.Fragment>
                         );
                       });
                     })()}
                  </>
                )}
              </>
            )}
          </div>

          <div className="list-header" style={{ display: viewMode === 'grid' ? 'none' : 'grid' }}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'center'}}>
              <div 
                className={`custom-checkbox ${checkedFileIds.size === files.length && files.length > 0 ? 'checked' : ''}`}
                onClick={() => {
                  if (checkedFileIds.size === files.length) setCheckedFileIds(new Set());
                  else setCheckedFileIds(new Set(files.map(f => f.id)));
                }}
              >
                {checkedFileIds.size === files.length && files.length > 0 && <svg viewBox="0 0 12 12" width="10" height="10" fill="white"><path d="M4.5 9L1.5 6l1-1 2 2 5-5 1 1-6 6z"/></svg>}
                {checkedFileIds.size > 0 && checkedFileIds.size < files.length && <svg viewBox="0 0 12 12" width="10" height="10" fill="white"><rect x="2" y="5" width="8" height="2" rx="1"/></svg>}
              </div>
            </div>
            <div></div>
            <div className="list-header-item sorted">Name ↑</div>
            <div className="list-header-item">Modified</div>
            <div className="list-header-item">Size</div>
            <div className="list-header-item">Memory</div>
          </div>

          <div className="file-items" id="fileItems">
            {files.length > 0 ? (
               viewMode === 'grid' ? renderGrid() : renderTree(fileTree, 0)
            ) : <div style={{padding:'20px', textAlign:'center', color:'var(--text-tertiary)'}}>No files found</div>}
          </div>
        </div>

        
        <div 
          className="resizer" 
          onMouseDown={(e) => { 
            isResizing.current = true; 
            startX.current = e.clientX;
            startWidth.current = previewWidth;
            document.body.style.cursor = 'col-resize'; 
            e.preventDefault();
          }}
        />
        
        <div className="preview-panel" id="previewPanel" style={{ width: previewWidth, flexShrink: 0 }}>
          <div className="preview-tabs">
            <div className={`preview-tab ${activeTab === 'info' ? 'active' : ''}`} onClick={() => setActiveTab('info')}>
              <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
              File Summary
            </div>
            <div className={`preview-tab ${activeTab === 'manage' ? 'active' : ''}`} onClick={() => setActiveTab('manage')}>
              ✨ File Actions
            </div>
            <div className={`preview-tab ${activeTab === 'actions' ? 'active' : ''}`} onClick={() => setActiveTab('actions')}>
              🤖 Agent<svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            </div>
          </div>

          <div className="preview-content" id="tab-manage" style={{ display: activeTab === 'manage' ? 'flex' : 'none', flexDirection: 'column', gap: '12px' }}>
            <div className="memory-panel">
              <div className="memory-panel-title">
                <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                AI Graph Organization
              </div>
              <div className="mem-level-text" style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                Analyzes context via Neo4j Graph to extract topics and automatically organize files into folders.
              </div>
            </div>

            <div style={{ padding: '12px', background: 'rgba(0,0,0,0.2)', borderRadius: 'var(--radius-md)', border: '1px solid var(--divider)' }}>
              <div style={{ fontSize: '10px', fontWeight: '600', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
                Target Directory
              </div>
              <div style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: selectedFile ? 'var(--accent)' : 'var(--text-tertiary)', wordBreak: 'break-all' }}>
                {selectedFile ? selectedFile.file_path.substring(0, selectedFile.file_path.lastIndexOf('/')) : 'Select a file first'}
              </div>
            </div>

            <div className="action-btn" style={{ padding: '12px', justifyContent: 'center', textAlign: 'center', opacity: (!selectedFile || isOrganizing) ? 0.5 : 1, cursor: (!selectedFile || isOrganizing) ? 'not-allowed' : 'pointer' }} onClick={async () => {
              if (!selectedFile || isOrganizing) return;
              const parentDir = selectedFile.file_path.substring(0, selectedFile.file_path.lastIndexOf('/'));
              setIsOrganizing(true);
              setOrganizeResult('Calling Graph analysis algorithm... (Please wait)');
              try {
                const res = await fetch('http://127.0.0.1:8001/api/directory/organize', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({ dir_path: parentDir, max_categories: 5 })
                });
                const data = await res.json();
                if (data.error || data.detail) {
                  setOrganizeResult('❌ Error: ' + (data.error || JSON.stringify(data.detail)));
                } else {
                  setOrganizeResult(`✅ Organization successful! Extracted ${data.categories.length} topics:\n${data.categories.join(', ')}\n\nDetails:\n${data.message}`);
                  fetchFiles();
                }
              } catch(e) {
                setOrganizeResult('Request failed: ' + e);
              }
              setIsOrganizing(false);
            }}>
              <div className="action-btn-icon" style={{ background: 'linear-gradient(135deg, rgba(10,132,255,0.2), rgba(191,90,242,0.2))' }}>
                {isOrganizing ? '⟳' : '✨'}
              </div>
              <div className="action-btn-body">
                <div className="action-btn-label">{isOrganizing ? 'Analyzing & Organizing...' : 'Auto-Organize Current Directory'}</div>
                <div className="action-btn-desc">{isOrganizing ? 'Extracting topics from directory...' : 'Extracts top 5 topics and creates folders'}</div>
              </div>
            </div>

            {organizeResult && (
              <div style={{ padding: '12px', background: 'rgba(0,0,0,0.2)', borderRadius: 'var(--radius-md)', border: '1px solid var(--divider)' }}>
                <div style={{ fontSize: '10px', fontWeight: '600', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                  Result
                </div>
                <pre style={{ margin: 0, fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: '200px', overflowY: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '1.5' }}>
                  {organizeResult}
                </pre>
              </div>
            )}
          </div>
          
          <div className="preview-content" id="tab-info" style={{ display: activeTab === 'info' ? 'flex' : 'none' }}>
            <div className="memory-panel" style={{marginTop: '12px'}}>
              <div className="memory-panel-title">
                <svg width="12" height="12" fill="var(--accent)" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                Summary
              </div>

              <div className="mem-level-text" style={{marginTop: '8px'}}>
                {selectedFileDetail?.memories?.[0]?.summary || 'No summary'}
              </div>
            </div>

            <div className="info-section">
              <div className="info-title">Keywords</div>
              <div style={{display:'flex',flexWrap:'wrap',gap:'5px',marginTop:'4px'}}>
                {selectedFileDetail?.memories?.[0]?.key_entities?.length > 0 ? 
                  selectedFileDetail.memories[0].key_entities.map((tag: string, idx: number) => (
                    <span key={idx} className="mem-tag blue">{tag}</span>
                  )) : <span style={{fontSize:'11px', color:'var(--text-tertiary)'}}>No keywords</span>
                }
              </div>
            </div>

            <div className="custom-divider"></div>

            <div className="info-section">
              <div className="info-title">Properties</div>
              <div className="info-row"><span className="info-key">Name</span><span className="info-val">{selectedFile?.file_name}</span></div>
              <div className="info-row"><span className="info-key">Path</span><span className="info-val mono" style={{whiteSpace: 'normal', wordBreak: 'break-all'}}>{selectedFile?.file_path}</span></div>
              <div className="info-row"><span className="info-key">Type</span><span className="info-val">{selectedFile?.file_type || 'Unknown'}</span></div>
              <div className="info-row"><span className="info-key">Size</span><span className="info-val mono">{selectedFile ? (selectedFile.file_size / 1024).toFixed(1) + ' KB' : ''}</span></div>
              <div className="info-row"><span className="info-key">Modified</span><span className="info-val mono">{selectedFile ? new Date(selectedFile.last_modified * 1000).toLocaleDateString() : ''}</span></div>
            </div>

            <div className="info-section">
              <div className="info-title">Index Status</div>
              <div className="info-row"><span className="info-key">File ID</span><span className="info-val mono">{selectedFile?.id}</span></div>
              <div className="info-row"><span className="info-key">Memories</span><span className="info-val mono">{selectedFileDetail?.memories?.length || 0} items</span></div>
            </div>

            <div className="custom-divider"></div>

            <div className="info-section">
              <div className="info-title">System Logs (Evolution)</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto', paddingRight: '5px', marginTop: '4px' }}>
                {selectedFileDetail?.change_logs?.map((log: any, idx: number) => {
                   const getLogIcon = (op: string) => {
                     if(op === 'CREATED') return <span style={{color: 'var(--accent-green)'}}>✦</span>;
                     if(op === 'UPDATED') return <span style={{color: 'var(--accent)'}}>✎</span>;
                     if(op === 'DELETED') return <span style={{color: 'var(--red)'}}>✕</span>;
                     if(op === 'RESTORED') return <span style={{color: 'var(--accent-green)'}}>⟲</span>;
                     return <span style={{color: 'var(--text-secondary)'}}>➦</span>;
                   };
                   const getLogLabel = (op: string) => {
                     if(op === 'CREATED') return 'Initially Indexed';
                     if(op === 'UPDATED') return 'Content Updated (Re-indexed)';
                     if(op === 'DELETED') return 'Moved to Trash';
                     if(op === 'RESTORED') return 'Restored from Trash';
                     return op;
                   };
                   
                   const d = new Date(log.timestamp + 'Z'); // parse as UTC
                   const timeStr = `${d.getMonth()+1}-${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
                   
                   return (
                     <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px' }}>
                       <div style={{ width: '16px', textAlign: 'center', marginTop: '-1px' }}>{getLogIcon(log.operation)}</div>
                       <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '2px' }}>
                         <div style={{ color: 'var(--text-primary)' }}>{getLogLabel(log.operation)}</div>
                         {log.old_path && log.operation !== 'DELETED' && <div style={{ color: 'var(--text-tertiary)', fontSize: '10px', wordBreak: 'break-all' }}>Path: {log.old_path}</div>}
                       </div>
                       <div style={{ color: 'var(--text-tertiary)', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>{timeStr}</div>
                     </div>
                   );
                })}
                {(!selectedFileDetail?.change_logs || selectedFileDetail.change_logs.length === 0) && (
                   <div style={{fontSize:'12px', color:'var(--text-tertiary)', fontStyle:'italic'}}>No log records</div>
                )}
              </div>
            </div>
          </div>

          
          <div className="preview-content" id="tab-actions" style={{ position: 'relative', display: activeTab === 'actions' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: '10px' }}>
              <div style={{display: 'flex', gap: '8px'}}>
                <button 
                  onClick={() => {
                    fetch('http://127.0.0.1:8001/api/agent/sessions')
                      .then(res => res.json())
                      .then(data => {
                        if (Array.isArray(data)) {
                          setSessionsList(data);
                        } else {
                          setSessionsList([]);
                          console.error("Failed to load sessions", data);
                        }
                        setShowHistoryModal(true);
                      })
                      .catch(e => {
                        console.error(e);
                        setSessionsList([]);
                        setShowHistoryModal(true);
                      });
                  }}
                  style={{
                    backgroundColor: 'transparent',
                    border: '1px solid rgba(0,0,0,0.1)',
                    color: 'var(--text-secondary)',
                    fontSize: '11px',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    transition: 'background-color 0.2s'
                  }}
              onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.04)'}
              onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              History
            </button>
            <button 
              onClick={() => {
                setSessionId(null);
                localStorage.removeItem('agentSessionId');
                setChatHistory([]);
              }}
              style={{
                backgroundColor: 'transparent',
                border: '1px solid rgba(0,0,0,0.1)',
                color: 'var(--text-secondary)',
                fontSize: '11px',
                padding: '4px 8px',
                borderRadius: '4px',
                cursor: 'pointer',
                transition: 'background-color 0.2s'
              }}
              onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.04)'}
                  onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  New Session +
                </button>
              </div>
            </div>

            {/* History Modal */}
            {showHistoryModal && (
              <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, 
                backgroundColor: 'var(--bg-window)', zIndex: 10, padding: '15px',
                display: 'flex', flexDirection: 'column', borderRadius: '8px',
                boxShadow: '0 4px 24px rgba(0,0,0,0.4)'
              }}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px'}}>
                  <div style={{color: 'var(--text-primary)', fontSize: '14px', fontWeight: 'bold'}}>Chat History</div>
                  <button onClick={() => setShowHistoryModal(false)} style={{background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '16px'}}>✕</button>
                </div>
                <div style={{flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px'}}>
                  {sessionsList.length === 0 ? (
                    <div style={{color: 'var(--text-tertiary)', fontSize: '12px', textAlign: 'center', marginTop: '20px'}}>No history records</div>
                  ) : (
                    sessionsList.map(s => (
                      <div 
                        key={s.id} 
                        onClick={() => {
                          setSessionId(s.id);
                          localStorage.setItem('agentSessionId', s.id);
                          setShowHistoryModal(false);
                        }}
                        style={{
                          padding: '10px',
                          backgroundColor: s.id === sessionId ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.02)',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          border: s.id === sessionId ? '1px solid var(--accent)' : '1px solid transparent'
                        }}
                        onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.04)'}
                        onMouseOut={(e) => e.currentTarget.style.backgroundColor = s.id === sessionId ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.02)'}
                      >
                        <div style={{fontSize: '13px', color: 'var(--text-primary)', marginBottom: '4px'}}>{s.title || 'Chat Session'}</div>
                        <div style={{fontSize: '11px', color: 'var(--text-tertiary)'}}>{new Date(s.created_at).toLocaleString()}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
            {/* Chat History */}
            <div style={{flex: 1, overflowY: 'auto', marginBottom: '10px', display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '4px'}}>
              {chatHistory.length === 0 && (
                <div style={{textAlign: 'center', color: 'var(--text-tertiary)', marginTop: '20px', fontSize: '13px'}}>
                  How can I help? Try asking: "Where is the login logic?"
                </div>
              )}
              {chatHistory.map((msg, idx) => (
                <div key={idx} style={{
                  alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  backgroundColor: msg.role === 'user' ? 'var(--accent)' : 'rgba(0,0,0,0.04)',
                  color: msg.role === 'user' ? '#fff' : 'var(--text-primary)',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  maxWidth: '90%',
                  fontSize: '13px',
                  lineHeight: '1.5',
                  wordBreak: 'break-word',
                  border: msg.role === 'user' ? 'none' : '1px solid rgba(0,0,0,0.08)'
                }}>
                  {msg.role === 'agent' ? (
                    <div className="markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    </div>
                  ) : (
                    msg.content
                  )}
                </div>
              ))}
              {isAgentTyping && (
                <div style={{alignSelf: 'flex-start', color: 'var(--text-tertiary)', fontSize: '12px'}}>
                  🤖 Agent is thinking and retrieving files...
                </div>
              )}
            </div>

            {/* Chat Input */}
            <div style={{display: 'flex', gap: '8px', marginTop: 'auto', marginBottom: '15px'}}>
              <textarea 
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { 
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendChatMessage();
                  }
                }}
                placeholder="Give commands or ask questions (Shift + Enter to wrap)..."
                style={{
                  flex: 1,
                  backgroundColor: 'rgba(0,0,0,0.04)',
                  border: '1px solid rgba(0,0,0,0.1)',
                  borderRadius: '8px',
                  padding: '10px 12px',
                  color: 'var(--text-primary)',
                  outline: 'none',
                  fontSize: '13px',
                  minHeight: '44px',
                  maxHeight: '120px',
                  resize: 'none',
                  lineHeight: '1.4'
                }}
              />
              <button 
                onClick={sendChatMessage}
                disabled={isAgentTyping}
                style={{
                  backgroundColor: isAgentTyping ? 'var(--bg-hover)' : 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '0 14px',
                  cursor: isAgentTyping ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '44px',
                  alignSelf: 'flex-end'
                }}
              >
                <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>
              </button>
            </div>

          </div>
        </div>
      </>
    )}
  </div>

  
  {showAiSearch && (
  <div className={`ai-overlay visible`} id="aiOverlay" onClick={() => setShowAiSearch(false)} style={{ display: 'flex' }}>
    <div className="ai-dialog" onClick={(e) => e.stopPropagation()}>
      <div className="ai-search-row">
        <div className="ai-search-icon">✦</div>
        <input 
          className="ai-search-input" 
          id="aiInput" 
          placeholder="Search file content, summaries or entities..." 
          autoFocus
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <span className="ai-kbd">ESC</span>
      </div>
      <div className="ai-results" id="aiResults">
        {isSearching && <div style={{padding: '20px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '13px'}}>AI is searching...</div>}
        
        {!isSearching && searchResults.length > 0 && (
          <>
            <div className="ai-section-label">Qdrant Vector Matches</div>
            {searchResults.map((res: any, idx: number) => {
              const snippet = res.summary ? (res.summary.length > 60 ? res.summary.substring(0, 60) + '...' : res.summary) : 'No summary';
              return (
                <div key={idx} className="ai-result-item" onClick={() => {
                  const file = files.find(f => f.id === res.file_id);
                  if (file) {
                    if (file.is_deleted) setCurrentFolder('trash');
                    else setCurrentFolder('active');
                    const parentDir = file.file_path.substring(0, file.file_path.lastIndexOf('/'));
                    setExpandedFolders(prev => {
                      const next = new Set(prev);
                      const parts = parentDir.split('/');
                      for (let i = 2; i <= parts.length; i++) {
                        next.add(parts.slice(0, i).join('/'));
                      }
                      return next;
                    });
                    handleSelectFile(file);
                  }
                  setShowAiSearch(false);
                }}>
                  <div className="ai-result-icon">📄</div>
                  <div className="ai-result-body">
                    <div className="ai-result-name">{res.file_name}</div>
                    <div className="ai-result-snippet">Score {res.score}% · {snippet}</div>
                  </div>
                  <div className="ai-result-meta">Hit</div>
                </div>
              );
            })}
          </>
        )}
        
        {!isSearching && searchQuery && searchResults.length === 0 && (
          <div style={{padding: '20px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '13px'}}>No files matched</div>
        )}
        
        {!searchQuery && (
          <div style={{padding: '20px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '13px'}}>
            Enter keywords to start high-dim vector search...
          </div>
        )}
      </div>
      <div className="ai-footer">
        <div className="ai-footer-dot"></div>
        Global vector engine ready · Click file to view summary
      </div>
    </div>
  </div>
  )}

  
  <div className={`confirm-bar ${checkedFileIds.size > 0 ? 'visible' : ''}`} id="confirmBar">
    <div className="confirm-icon" id="confirmIcon">🗑️</div>
    <div className="confirm-body">
      <div className="confirm-title" id="confirmTitle">{currentFolder === 'active' ? 'Batch Move to Trash' : 'Delete Permanently'}</div>
      <div className="confirm-desc" id="confirmDesc">
        {currentFolder === 'active' 
          ? `Selected ${checkedFileIds.size} files. AI memories will be retained and can be restored.` 
          : `Selected ${checkedFileIds.size} files. Memories and features will be permanently lost!`}
      </div>
    </div>
    <div className="confirm-btns">
      <button className="c-btn c-btn-cancel" onClick={() => setCheckedFileIds(new Set())}>Clear Selection</button>
      {currentFolder === 'trash' && (
        <button className="c-btn c-btn-confirm" style={{background:'var(--accent)', marginRight: '8px'}} onClick={() => batchAction('restore')}>Restore</button>
      )}
      <button className="c-btn c-btn-confirm" style={{background:'var(--accent-red)'}} onClick={() => batchAction(currentFolder === 'active' ? 'trash' : 'delete')}>
        {currentFolder === 'active' ? 'Move to Trash' : 'Delete Permanently'}
      </button>
    </div>
  </div>

      {showPreviewModal && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, 
          backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div style={{
            width: '80%', height: '80%', backgroundColor: 'var(--bg-window)',
            borderRadius: '12px', boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            border: '1px solid rgba(0,0,0,0.1)'
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', 
              padding: '15px 20px', borderBottom: '1px solid rgba(0,0,0,0.06)',
              backgroundColor: 'rgba(0,0,0,0.02)'
            }}>
              <div style={{color: 'var(--text-primary)', fontSize: '15px', fontWeight: 'bold'}}>{previewTitle}</div>
              <button onClick={() => setShowPreviewModal(false)} style={{background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '16px'}}>✕</button>
            </div>
            <div style={{flex: 1, padding: '20px', overflowY: 'auto', color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.6', whiteSpace: 'pre-wrap'}}>
              {previewContent}
            </div>
          </div>
        </div>
      )}

</div>
    </>
  );
}
