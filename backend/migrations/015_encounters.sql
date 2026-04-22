-- Migration: 015_encounters
-- Description: Encounters table with clinical fields

CREATE TABLE IF NOT EXISTS encounters (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id       INTEGER NOT NULL REFERENCES users(id),
  clinic_id        INTEGER NOT NULL REFERENCES users(id),
  encountered_by   INTEGER REFERENCES users(id),
  chief_complaint  TEXT NOT NULL,
  notes            TEXT,
  ai_summary       TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','cancelled')),
  diagnosis        TEXT,
  vital_signs      TEXT,
  prescriptions    TEXT,
  follow_up_date   DATETIME,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_encounters_clinic_patient_created
  ON encounters(clinic_id, patient_id, created_at);
