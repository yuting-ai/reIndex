import uuid
import datetime
from typing import List, Optional
import os

from sqlalchemy import String, Integer, Float, DateTime, Text, JSON, ForeignKey, Boolean
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy import create_engine

class Base(DeclarativeBase):
    pass

class FileIndex(Base):
    """
    Physical file properties table (FILE_INDEX)
    Records the physical existence and metadata of files in the system.
    """
    __tablename__ = "file_index"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    file_name: Mapped[str] = mapped_column(String, nullable=False)
    file_path: Mapped[str] = mapped_column(String, nullable=False, unique=True) # File path must be unique
    file_type: Mapped[str] = mapped_column(String, nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    last_modified: Mapped[float] = mapped_column(Float, nullable=False) # Stores the timestamp
    content_hash: Mapped[str] = mapped_column(String, nullable=False) # Used to detect file content changes
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False) # Soft delete flag

    # Relationships: One file can have multiple memory records (chunks) and multiple operation logs
    # Memory records can be cascaded and deleted if the physical file is truly deleted
    memory_records: Mapped[List["MemoryRecord"]] = relationship(back_populates="file", cascade="all, delete-orphan")
    # Operation logs must never be cascaded! Traceability must be preserved even if the file is gone
    change_logs: Mapped[List["ChangeLog"]] = relationship(back_populates="file")

    def __repr__(self):
        return f"<FileIndex(name='{self.file_name}')>"

class MemoryRecord(Base):
    """
    Memory record table (MEMORY_RECORD)
    Records the AI's understanding of the file (summary, entities, chunked text).
    """
    __tablename__ = "memory_record"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    file_id: Mapped[str] = mapped_column(ForeignKey("file_index.id"), nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, default=0)
    total_chunks: Mapped[int] = mapped_column(Integer, default=1)
    content_text: Mapped[str] = mapped_column(Text, nullable=False) # Original parsed text
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True) # LLM generated summary
    key_entities: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True) # LLM extracted entities

    # Relationship back to FileIndex
    file: Mapped["FileIndex"] = relationship(back_populates="memory_records")

    def __repr__(self):
        return f"<MemoryRecord(file_id='{self.file_id}', chunk='{self.chunk_index}/{self.total_chunks}')>"

class ChangeLog(Base):
    """
    Change log table (CHANGE_LOG)
    Records all operations on files, supporting Agentic Workflow auditing and rollback.
    """
    __tablename__ = "change_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    file_id: Mapped[str] = mapped_column(ForeignKey("file_index.id"), nullable=False)
    operation: Mapped[str] = mapped_column(String, nullable=False) # Enum: CREATED, UPDATED, MOVED, RENAMED, DELETED, RESTORED
    old_path: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    new_path: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    timestamp: Mapped[datetime.datetime] = mapped_column(DateTime, default=datetime.datetime.utcnow)

    # Relationship back to FileIndex
    file: Mapped["FileIndex"] = relationship(back_populates="change_logs")

    def __repr__(self):
        return f"<ChangeLog(op='{self.operation}', time='{self.timestamp}')>"

class ChatSession(Base):
    """
    Chat Session table
    Groups chat messages into sessions.
    """
    __tablename__ = "chat_session"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=datetime.datetime.utcnow)
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    summary_msg_count: Mapped[int] = mapped_column(Integer, default=0)
    
    messages: Mapped[List["ChatMessage"]] = relationship(back_populates="session", cascade="all, delete-orphan")

class ChatMessage(Base):
    """
    Chat Message table
    Stores individual messages for short-term memory.
    """
    __tablename__ = "chat_message"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id: Mapped[str] = mapped_column(ForeignKey("chat_session.id"), nullable=False)
    role: Mapped[str] = mapped_column(String, nullable=False) # 'user' or 'agent'
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=datetime.datetime.utcnow)

    session: Mapped["ChatSession"] = relationship(back_populates="messages")

DB_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
DEFAULT_DB_PATH = f"sqlite:///{os.path.join(DB_DIR, 'reindex.db')}"

def init_db(db_path: str = DEFAULT_DB_PATH):
    """
    Initializes the database engine and creates the table structures.
    """
    # echo=False. Set to True during debugging to print all underlying SQL statements
    engine = create_engine(db_path, echo=False)
    Base.metadata.create_all(engine)
    print(f"✅ Database initialized successfully: {db_path}")
    return engine


