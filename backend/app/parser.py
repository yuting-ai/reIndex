import os
from pathlib import Path

# A set of file extensions that we know are plain text and can be read directly
PLAIN_TEXT_EXTENSIONS = {
    ".txt", ".md", ".py", ".csv", ".json", ".xml", ".html", ".css", ".js"
}

# A set of binary extensions that we should completely ignore for text extraction
IGNORED_EXTENSIONS = {
    ".db", ".exe", ".dll", ".so", ".dylib", ".zip", ".tar", ".gz", ".sqlite", ".pyc"
}

# Image extensions supported by EasyOCR
IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".bmp"
}

# Lazy-loaded OCR reader to avoid slow startup times when not scanning images
_ocr_reader = None

def get_ocr_reader():
    global _ocr_reader
    if _ocr_reader is None:
        import easyocr
        print("🚀 Loading EasyOCR visual model into memory (first load may take a few seconds)...")
        _ocr_reader = easyocr.Reader(['ch_sim', 'en'])
    return _ocr_reader

def parse_image(file_path: str) -> str:
    """Extracts text from an image using local EasyOCR."""
    try:
        reader = get_ocr_reader()
        result = reader.readtext(file_path, detail=0)
        return "\n".join(result)
    except Exception as e:
        print(f"Error reading image {file_path}: {e}")
        return ""

def parse_plain_text(file_path: str) -> str:
    """Reads a plain text file using UTF-8 encoding."""
    try:
        # We use errors='replace' so that if a file isn't perfectly UTF-8, 
        # it won't crash the program, but will replace invalid chars with a placeholder.
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception as e:
        print(f"Error reading plain text file {file_path}: {e}")
        return ""

def parse_pdf(file_path: str) -> str:
    """
    Stub for PDF parsing. 
    Later we will install libraries like PyPDF2 or pdfplumber and implement this.
    """
    # TODO: Implement PDF parsing logic
    return "[PDF content extraction not yet implemented]"

def parse_docx(file_path: str) -> str:
    """
    Stub for Word document parsing.
    Later we will install python-docx and implement this.
    """
    # TODO: Implement DOCX parsing logic
    return "[DOCX content extraction not yet implemented]"

def parse_file(file_path: str) -> str:
    """
    Main entry point for file parsing. 
    Routes the file to the appropriate parser based on its extension.
    Returns the extracted text, or an empty string if it cannot be parsed.
    """
    path_obj = Path(file_path)
    if not path_obj.exists() or not path_obj.is_file():
        print(f"File not found: {file_path}")
        return ""
    
    # Exclude system files like .DS_Store
    if path_obj.name.startswith('.'):
        return ""

    extension = path_obj.suffix.lower()

    if extension in IGNORED_EXTENSIONS:
        print(f"Ignoring binary/system file: {path_obj.name}")
        return ""
        
    elif extension in PLAIN_TEXT_EXTENSIONS:
        return parse_plain_text(file_path)
        
    elif extension == ".pdf":
        return parse_pdf(file_path)
        
    elif extension in {".docx", ".doc"}:
        return parse_docx(file_path)
        
    elif extension in IMAGE_EXTENSIONS:
        return parse_image(file_path)
        
    else:
        # Fallback: If we don't know the extension, try to gently read it as plain text.
        # If it fails, `parse_plain_text` will handle the error and return an empty string.
        print(f"Unknown extension {extension}, attempting fallback text extraction...")
        return parse_plain_text(file_path)


