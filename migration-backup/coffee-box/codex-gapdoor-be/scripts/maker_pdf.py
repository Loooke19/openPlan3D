"""Inspect uploaded PDFs without executing embedded JavaScript or launching files."""
from pypdf import PdfReader
from pypdf.errors import PdfReadError


class PdfRejected(ValueError):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


def inspect_pdf(path, max_pages):
    header = path.read_bytes()[:8]
    if not header.startswith(b"%PDF"):
        raise PdfRejected("不是有效的 PDF 文件。")
    try:
        reader = PdfReader(str(path), strict=False)
    except PdfReadError as error:
        raise PdfRejected("无法读取这份 PDF，文件可能已损坏。") from error
    except Exception as error:
        raise PdfRejected("无法读取这份 PDF。") from error
    if getattr(reader, "is_encrypted", False):
        raise PdfRejected("无法读取加密 PDF。请先在本地解除加密后再上传。")
    count = len(reader.pages)
    if count < 1:
        raise PdfRejected("这份 PDF 没有可显示的页面。")
    if count > max_pages:
        raise PdfRejected(f"页数超过限制（最多 {max_pages} 页）。")
    pages = []
    for index, page in enumerate(reader.pages, start=1):
        box = page.mediabox
        width = float(box.width)
        height = float(box.height)
        if not (width > 0 and height > 0):
            raise PdfRejected(f"第 {index} 页尺寸无效。")
        pages.append({"index": index, "originalSize": [width, height]})
    return pages
