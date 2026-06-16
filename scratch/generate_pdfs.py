import os
import json
from fpdf import FPDF

class SheeritPDF(FPDF):
    def header(self):
        self.set_font('helvetica', 'B', 15)
        self.set_text_color(26, 54, 93)
        self.cell(0, 10, 'SHEERIT STORE', 0, new_x="LMARGIN", new_y="NEXT", align='L')
        self.set_draw_color(26, 54, 93)
        self.set_line_width(1)
        self.line(10, 22, 200, 22)
        self.ln(8)

    def footer(self):
        self.set_y(-15)
        self.set_font('helvetica', 'I', 8)
        self.set_text_color(128, 128, 128)
        self.cell(0, 10, f'Página {self.page_no()}', 0, new_x="RIGHT", new_y="TOP", align='C')

def load_policies():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    json_path = os.path.join(script_dir, "..", "policies.json")
    if not os.path.exists(json_path):
        # Fallback local a la carpeta actual si no se encuentra
        json_path = os.path.join(script_dir, "policies.json")
    
    with open(json_path, 'r', encoding='utf-8') as f:
        return json.load(f)

def create_tc_pdf(filename, sections):
    pdf = SheeritPDF()
    pdf.alias_nb_pages()
    pdf.add_page()
    pdf.set_font('helvetica', '', 10)
    pdf.set_text_color(33, 37, 41)
    
    # Title of document
    pdf.set_font('helvetica', 'B', 14)
    pdf.cell(0, 10, 'Términos y Condiciones de Uso y Tratamiento de Datos', 0, new_x="LMARGIN", new_y="NEXT", align='C')
    pdf.ln(5)
    
    def add_section(title, text_list):
        pdf.set_font('helvetica', 'B', 11)
        pdf.set_text_color(26, 54, 93)
        pdf.cell(0, 8, title, 0, new_x="LMARGIN", new_y="NEXT", align='L')
        pdf.set_font('helvetica', '', 10)
        pdf.set_text_color(33, 37, 41)
        for paragraph in text_list:
            pdf.multi_cell(0, 5, paragraph)
            pdf.ln(3)
        pdf.ln(2)

    for section in sections:
        add_section(section["title"], section["paragraphs"])

    os.makedirs(os.path.dirname(filename), exist_ok=True)
    pdf.output(filename)
    print(f"Generated PDF: {filename}")

def create_reembolso_pdf(filename, sections):
    pdf = SheeritPDF()
    pdf.alias_nb_pages()
    pdf.add_page()
    pdf.set_font('helvetica', '', 10)
    pdf.set_text_color(33, 37, 41)
    
    # Title of document
    pdf.set_font('helvetica', 'B', 14)
    pdf.cell(0, 10, 'Políticas de Reembolso y Cambios de Plataforma', 0, new_x="LMARGIN", new_y="NEXT", align='C')
    pdf.ln(5)
    
    def add_section(title, text_list):
        pdf.set_font('helvetica', 'B', 11)
        pdf.set_text_color(26, 54, 93)
        pdf.cell(0, 8, title, 0, new_x="LMARGIN", new_y="NEXT", align='L')
        pdf.set_font('helvetica', '', 10)
        pdf.set_text_color(33, 37, 41)
        for paragraph in text_list:
            pdf.multi_cell(0, 5, paragraph)
            pdf.ln(3)
        pdf.ln(2)

    for section in sections:
        add_section(section["title"], section["paragraphs"])

    os.makedirs(os.path.dirname(filename), exist_ok=True)
    pdf.output(filename)
    print(f"Generated PDF: {filename}")

if __name__ == '__main__':
    policies = load_policies()
    
    # Public directory
    create_tc_pdf("/Users/estebanavila/desarrollo/sheeritpage/public/T&C_sheerit.pdf", policies["terms_and_conditions"])
    create_reembolso_pdf("/Users/estebanavila/desarrollo/sheeritpage/public/reembolsoSheerit.pdf", policies["refund_policy"])
    
    # Dist directory (if it exists)
    if os.path.exists("/Users/estebanavila/desarrollo/sheeritpage/dist"):
        create_tc_pdf("/Users/estebanavila/desarrollo/sheeritpage/dist/T&C_sheerit.pdf", policies["terms_and_conditions"])
        create_reembolso_pdf("/Users/estebanavila/desarrollo/sheeritpage/dist/reembolsoSheerit.pdf", policies["refund_policy"])

