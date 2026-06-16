import pypdf
import os

pdf_path = "/Users/estebanavila/desarrollo/sheeritpage/public/T&C_sheerit.pdf"
reader = pypdf.PdfReader(pdf_path)
text = ""
for i, page in enumerate(reader.pages):
    text += f"--- PAGE {i+1} ---\n"
    text += page.extract_text() + "\n"

out_path = "/Users/estebanavila/desarrollo/whatbot/scratch/tc_extracted.txt"
with open(out_path, "w", encoding="utf-8") as f:
    f.write(text)

print("Extracted successfully, size:", len(text))
