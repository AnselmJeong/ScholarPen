-- Gives the manuscript's own tables the "ScholarPen Table" style that
-- reference-doc.lua defines. A table that already names a custom-style keeps it.

local STYLE_ID = "ScholarPenTable"

-- Quarto puts a captioned table or figure inside a one-cell layout table.
-- Those hold other tables or images and keep pandoc's plain "Table" style, so
-- no rule is drawn around a caption.
local function is_layout_table(tbl)
  local nested = false
  local mark = function() nested = true end
  local filter = { Table = mark, Figure = mark, Image = mark }
  local function scan(rows)
    for _, row in ipairs(rows) do
      for _, cell in ipairs(row.cells) do
        pandoc.Blocks(cell.contents):walk(filter)
      end
    end
  end
  scan(tbl.head.rows)
  for _, body in ipairs(tbl.bodies) do
    scan(body.head)
    scan(body.body)
  end
  scan(tbl.foot.rows)
  return nested
end

function Table(tbl)
  if tbl.attributes["custom-style"] or is_layout_table(tbl) then return nil end
  tbl.attributes["custom-style"] = STYLE_ID
  return tbl
end
