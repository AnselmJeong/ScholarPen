-- Builds ScholarPen's Word reference document: pandoc's own default
-- reference.docx plus the "ScholarPen Table" style. Generating it from the
-- installed pandoc keeps every other style in step with that pandoc version.
--
-- Usage: pandoc lua reference-doc.lua OUTPUT.docx

local STYLE_ID = "ScholarPenTable"
-- A 1 pt single rule (w:sz counts eighths of a point).
local RULE = '<w:%s w:val="single" w:sz="8" w:space="0" w:color="auto"/>'

-- One rule above the table and one under it; the header row adds the rule
-- beneath it. Cell margins and the rest come from pandoc's "Table" style.
local STYLE = table.concat({
  '<w:style w:type="table" w:customStyle="1" w:styleId="', STYLE_ID, '">',
  '<w:name w:val="ScholarPen Table"/>',
  '<w:basedOn w:val="Table"/>',
  '<w:qFormat/>',
  '<w:tblPr><w:tblBorders>', RULE:format("top"), RULE:format("bottom"), '</w:tblBorders></w:tblPr>',
  '<w:tblStylePr w:type="firstRow"><w:tcPr><w:tcBorders>', RULE:format("bottom"),
  '</w:tcBorders><w:vAlign w:val="bottom"/></w:tcPr></w:tblStylePr>',
  '</w:style>',
})

local output = assert(arg[1], "usage: pandoc lua reference-doc.lua OUTPUT.docx")
-- pandoc copies every style of its default reference document into its output.
local archive = pandoc.zip.Archive(pandoc.write(pandoc.Pandoc({}), "docx"))
local entries = pandoc.List()
for _, entry in ipairs(archive.entries) do
  if entry.path == "word/styles.xml" then
    local xml = entry:contents()
    if not xml:find('w:styleId="' .. STYLE_ID .. '"', 1, true) then
      local closing = assert(xml:find("</w:styles>", 1, true), "word/styles.xml has no </w:styles>")
      xml = xml:sub(1, closing - 1) .. STYLE .. xml:sub(closing)
    end
    entry = pandoc.zip.Entry(entry.path, xml)
  end
  entries:insert(entry)
end

local file = assert(io.open(output, "wb"))
file:write(pandoc.zip.Archive(entries):bytestring())
file:close()
