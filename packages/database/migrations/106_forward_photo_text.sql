-- Photo text rules: Main reads the text of a photo with the local OCR engine and then decides.
-- ocr_state is null for every other rule mode. ocr_detail holds keywords or codes only, never the photo text.
ALTER TABLE agent_schedule_forward_work
  ADD COLUMN ocr_state text CHECK (ocr_state IN ('pending','hit','unclear','miss','unavailable')),
  ADD COLUMN ocr_detail text CHECK (ocr_detail IS NULL OR char_length(ocr_detail) <= 200);
CREATE INDEX agent_schedule_forward_ocr_idx ON agent_schedule_forward_work(created_at) WHERE ocr_state='pending';
