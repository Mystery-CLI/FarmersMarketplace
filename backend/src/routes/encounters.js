const router = require('express').Router();
const { z } = require('zod');
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');

const vitalSignsSchema = z.object({
  bloodPressure: z.string().optional(),
  heartRate: z.number().optional(),
  temperature: z.number().optional(),
  weight: z.number().optional(),
  height: z.number().optional(),
  oxygenSaturation: z.number().optional(),
}).optional();

const createSchema = z.object({
  patientId: z.number().int().positive(),
  chiefComplaint: z.string().min(1),
  notes: z.string().optional(),
  diagnosis: z.array(z.string()).optional(),
  vitalSigns: vitalSignsSchema,
  prescriptions: z.array(z.object({ name: z.string(), dose: z.string().optional() })).optional(),
  followUpDate: z.string().datetime().optional(),
  encounteredBy: z.number().int().positive().optional(),
  status: z.enum(['open', 'closed', 'cancelled']).optional(),
});

const updateSchema = createSchema.partial().omit({ patientId: true });

// GET /api/encounters — paginated list for the clinic
router.get('/', auth, async (req, res) => {
  try {
    const clinicId = req.user.id;
    const { patientId, status, from, to, encounteredBy, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = ['e.clinic_id = $1'];
    const params = [clinicId];
    let i = 2;

    if (patientId) { conditions.push(`e.patient_id = $${i++}`); params.push(patientId); }
    if (status) { conditions.push(`e.status = $${i++}`); params.push(status); }
    if (from) { conditions.push(`e.created_at >= $${i++}`); params.push(from); }
    if (to) { conditions.push(`e.created_at <= $${i++}`); params.push(to); }
    if (encounteredBy) { conditions.push(`e.encountered_by = $${i++}`); params.push(encounteredBy); }

    const where = conditions.join(' AND ');
    const { rows } = await db.query(
      `SELECT e.*, u.name AS patient_name FROM encounters e
       LEFT JOIN users u ON e.patient_id = u.id
       WHERE ${where} ORDER BY e.created_at DESC LIMIT $${i++} OFFSET $${i++}`,
      [...params, parseInt(limit), offset]
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM encounters e WHERE ${where}`,
      params
    );

    res.json({
      success: true,
      data: rows.map(deserialize),
      total: parseInt(countRows[0].total),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (e) {
    return err(res, 500, e.message, 'encounters_list_error');
  }
});

// GET /api/encounters/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT e.*, u.name AS patient_name FROM encounters e
       LEFT JOIN users u ON e.patient_id = u.id
       WHERE e.id = $1 AND e.clinic_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return err(res, 404, 'Encounter not found', 'not_found');
    res.json({ success: true, data: deserialize(rows[0]) });
  } catch (e) {
    return err(res, 500, e.message, 'encounter_fetch_error');
  }
});

// GET /api/encounters/patient/:patientId
router.get('/patient/:patientId', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM encounters WHERE patient_id = $1 AND clinic_id = $2 ORDER BY created_at DESC`,
      [req.params.patientId, req.user.id]
    );
    res.json({ success: true, data: rows.map(deserialize) });
  } catch (e) {
    return err(res, 500, e.message, 'encounter_fetch_error');
  }
});

// POST /api/encounters
router.post('/', auth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return err(res, 400, parsed.error.errors[0].message, 'validation_error');

  const { patientId, chiefComplaint, notes, diagnosis, vitalSigns, prescriptions, followUpDate, encounteredBy, status } = parsed.data;
  try {
    const { rows } = await db.query(
      `INSERT INTO encounters (patient_id, clinic_id, encountered_by, chief_complaint, notes, diagnosis, vital_signs, prescriptions, follow_up_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [patientId, req.user.id, encounteredBy || req.user.id, chiefComplaint, notes || null,
       JSON.stringify(diagnosis || []), JSON.stringify(vitalSigns || {}),
       JSON.stringify(prescriptions || []), followUpDate || null, status || 'open']
    );
    res.status(201).json({ success: true, data: deserialize(rows[0]) });
  } catch (e) {
    return err(res, 500, e.message, 'encounter_create_error');
  }
});

// PUT /api/encounters/:id
router.put('/:id', auth, async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return err(res, 400, parsed.error.errors[0].message, 'validation_error');

  try {
    const { rows: existing } = await db.query(
      'SELECT * FROM encounters WHERE id = $1 AND clinic_id = $2',
      [req.params.id, req.user.id]
    );
    if (!existing[0]) return err(res, 404, 'Encounter not found', 'not_found');
    if (existing[0].status === 'closed') return err(res, 409, 'Closed encounters cannot be edited', 'encounter_closed');

    const current = deserialize(existing[0]);
    const data = parsed.data;
    const updated = {
      chief_complaint: data.chiefComplaint ?? current.chiefComplaint,
      notes: data.notes ?? current.notes,
      diagnosis: JSON.stringify(data.diagnosis ?? current.diagnosis),
      vital_signs: JSON.stringify(data.vitalSigns ?? current.vitalSigns),
      prescriptions: JSON.stringify(data.prescriptions ?? current.prescriptions),
      follow_up_date: data.followUpDate ?? current.followUpDate,
      encountered_by: data.encounteredBy ?? current.encounteredBy,
      status: data.status ?? current.status,
    };

    const { rows } = await db.query(
      `UPDATE encounters SET
        chief_complaint=$1, notes=$2, diagnosis=$3, vital_signs=$4, prescriptions=$5,
        follow_up_date=$6, encountered_by=$7, status=$8, updated_at=CURRENT_TIMESTAMP
       WHERE id=$9 AND clinic_id=$10 RETURNING *`,
      [updated.chief_complaint, updated.notes, updated.diagnosis, updated.vital_signs,
       updated.prescriptions, updated.follow_up_date, updated.encountered_by, updated.status,
       req.params.id, req.user.id]
    );
    res.json({ success: true, data: deserialize(rows[0]) });
  } catch (e) {
    return err(res, 500, e.message, 'encounter_update_error');
  }
});

// DELETE /api/encounters/:id — soft delete (set status: 'cancelled')
router.delete('/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE encounters SET status='cancelled', updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND clinic_id=$2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return err(res, 404, 'Encounter not found', 'not_found');
    res.json({ success: true, message: 'Encounter cancelled' });
  } catch (e) {
    return err(res, 500, e.message, 'encounter_delete_error');
  }
});

function deserialize(row) {
  if (!row) return row;
  return {
    ...row,
    diagnosis: tryParse(row.diagnosis, []),
    vitalSigns: tryParse(row.vital_signs, {}),
    prescriptions: tryParse(row.prescriptions, []),
    chiefComplaint: row.chief_complaint,
    followUpDate: row.follow_up_date,
    encounteredBy: row.encountered_by,
    patientId: row.patient_id,
    clinicId: row.clinic_id,
    aiSummary: row.ai_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tryParse(val, fallback) {
  try { return val ? JSON.parse(val) : fallback; } catch { return fallback; }
}

module.exports = router;
