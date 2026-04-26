require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { execFile } = require('child_process');
const { promisify } = require('util');

const app = express();
const PORT = process.env.PUBLIC_PORT || process.env.PORT || 4444;
const SYNC_SECRET = process.env.PUBLIC_SYNC_SECRET || process.env.SYNC_SECRET || '';
const DOC_PDF_CONVERTER_URL = process.env.DOC_PDF_CONVERTER_URL || '';
const DOC_PDF_CONVERTER_KEY = process.env.DOC_PDF_CONVERTER_KEY || '';
const APPLICATION_NOTIFY_TO = process.env.APPLICATION_NOTIFY_TO || 'cv@djob.agency';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'no-reply@localhost';
const execFileAsync = promisify(execFile);
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 5 * 1024 * 1024 } });
const db = new Database(path.join(__dirname, 'public_jobs.db'));
const uploadsDir = path.join(__dirname, 'uploads', 'applications');

fs.mkdirSync(uploadsDir, { recursive: true });

const mailTransporter = SMTP_HOST && SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    })
  : null;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

db.exec(`
  CREATE TABLE IF NOT EXISTS public_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE,
    job_number TEXT UNIQUE,
    original_job_number TEXT,
    job_source TEXT,
    title TEXT,
    description TEXT,
    is_hot INTEGER DEFAULT 0,
    is_sticky INTEGER DEFAULT 0,
    is_preferred INTEGER DEFAULT 0,
    is_quick_apply INTEGER DEFAULT 0,
    show_updated_date INTEGER DEFAULT 1,
    embedding_statements TEXT,
    position_id TEXT,
    category TEXT,
    location TEXT,
    job_type TEXT,
    scope TEXT,
    position_status TEXT,
    svt_url TEXT,
    internal_salary TEXT,
    manager_name TEXT,
    screening_questions TEXT,
    company_description TEXT,
    job_description TEXT,
    share_link TEXT,
    publish_date TEXT,
    created_at TEXT,
    updated_at TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_uuid TEXT UNIQUE,
    job_uuid TEXT,
    job_number TEXT,
    position_id TEXT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    screening_answers TEXT,
    cv_original_name TEXT,
    cv_file_path TEXT,
    cv_file_type TEXT,
    noresume INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  UPDATE public_jobs SET
    original_job_number = NULL,
    job_source = NULL,
    is_preferred = 0,
    svt_url = NULL,
    manager_name = NULL,
    company_description = NULL,
    job_description = NULL,
    share_link = NULL,
    publish_date = NULL
`);

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function isAllowedResumeFile(file) {
  if (!file || !file.originalname) return false;
  const ext = path.extname(file.originalname).toLowerCase();
  return ext === '.pdf' || ext === '.doc';
}

function buildResumeFilename(fullName) {
  const baseName = String(fullName || '')
    .trim()
    .replace(/[^\w.\-()\u0590-\u05FF ]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '') || crypto.randomUUID();

  let filename = `${baseName}.pdf`;
  let counter = 2;

  while (fs.existsSync(path.join(uploadsDir, filename))) {
    filename = `${baseName}-${counter}.pdf`;
    counter += 1;
  }

  return filename;
}

async function convertDocToPdf(sourcePath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-doc-'));
  try {
    await execFileAsync('libreoffice', [
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      tmpDir,
      sourcePath,
    ]);

    const pdfPath = path.join(tmpDir, `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);
    if (!fs.existsSync(pdfPath)) {
      throw new Error('PDF not created');
    }
    return pdfPath;
  } catch (error) {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    const message = error.stderr || error.message || 'Error converting file';
    throw new Error(message.trim());
  }
}

async function persistResumeFile(file, fullName) {
  if (!isAllowedResumeFile(file)) {
    throw new Error('Only PDF or DOC files are allowed');
  }

  const ext = path.extname(file.originalname).toLowerCase();
  const uploadId = crypto.randomUUID();
  const originalSafeName = path.basename(file.originalname).replace(/[^\w.\-()\u0590-\u05FF ]/g, '_');
  const renamedInputPath = path.join(os.tmpdir(), `${uploadId}${ext}`);
  fs.renameSync(file.path, renamedInputPath);

  let workingPdfPath = renamedInputPath;

  try {
    if (ext === '.doc') {
      if (DOC_PDF_CONVERTER_URL) {
        workingPdfPath = await convertDocToPdfViaRemote(renamedInputPath, file.originalname);
      } else {
        workingPdfPath = await convertDocToPdf(renamedInputPath);
      }
    }

    const finalPdfPath = path.join(uploadsDir, buildResumeFilename(fullName));
    fs.copyFileSync(workingPdfPath, finalPdfPath);

    return {
      storedPath: path.relative(__dirname, finalPdfPath),
      originalName: originalSafeName,
      fileType: 'pdf',
    };
  } finally {
    if (fs.existsSync(renamedInputPath)) {
      fs.unlinkSync(renamedInputPath);
    }
    if (workingPdfPath !== renamedInputPath && fs.existsSync(workingPdfPath)) {
      fs.unlinkSync(workingPdfPath);
      const tempDir = path.dirname(workingPdfPath);
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }
}

function resolveStoredCvPath(storedPath) {
  if (!storedPath) return '';
  const normalized = String(storedPath).replace(/^\/+/, '');
  const candidates = [
    path.join(__dirname, normalized),
    path.join(__dirname, 'uploads', path.basename(normalized)),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function cleanupCvFileIfUnused(storedPath) {
  if (!storedPath) return;
  const inUse = db.prepare(`
    SELECT COUNT(*) AS count
    FROM applications
    WHERE cv_file_path = ?
  `).get(storedPath);

  if (Number(inUse?.count || 0) > 0) return;

  const resolvedPath = resolveStoredCvPath(storedPath);
  if (resolvedPath && fs.existsSync(resolvedPath)) {
    fs.unlinkSync(resolvedPath);
  }
}

function formatAnswersForEmail(screeningAnswers) {
  if (!screeningAnswers) return [];
  try {
    const parsed = JSON.parse(screeningAnswers);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function formatScreeningQuestions(screeningQuestions) {
  if (!screeningQuestions) return [];
  try {
    const parsed = JSON.parse(screeningQuestions);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendApplicationNotification({ application, job }) {
  if (!mailTransporter) {
    console.warn('SMTP is not configured. Skipping application notification email.');
    return { sent: false, skipped: true };
  }

  const answers = formatAnswersForEmail(application.screening_answers);
  const questions = formatScreeningQuestions(job?.screening_questions);
  const answerEntries = answers.map((item, index) => {
    const rawQuestion = questions[index];
    const questionText = typeof rawQuestion === 'string'
      ? rawQuestion
      : (rawQuestion?.text || rawQuestion?.question || `שאלה ${index + 1}`);

    return {
      index,
      questionText,
      answerText: item.answer || 'לא סופקה תשובה',
    };
  });
  const answersText = answers.length
    ? answerEntries.map(({ index, questionText, answerText }) => (
        `${index + 1}. ${questionText}\nתשובה: ${answerText}`
      )).join('\n\n')
    : 'אין תשובות לשאלות סינון';

  const attachmentPath = application.cv_file_path
    ? path.join(__dirname, application.cv_file_path)
    : null;
  const attachmentFilename = application.cv_file_path
    ? path.basename(application.cv_file_path)
    : 'resume.pdf';
  const answersHtml = answerEntries.length
    ? answerEntries.map(({ index, questionText, answerText }) => `
        <div style="margin-bottom:16px;">
          <div style="font-weight:700; color:#111827;">${index + 1}. ${escapeHtml(questionText)}</div>
          <div style="margin-top:4px; color:#374151;">תשובה:</div>
          <div style="margin-top:4px; color:#111827;">${escapeHtml(answerText)}</div>
        </div>
      `).join('')
    : '<div style="color:#374151;">אין תשובות לשאלות סינון</div>';

  const mailOptions = {
    from: SMTP_FROM,
    to: APPLICATION_NOTIFY_TO,
    subject: `מועמדות חדשה | ${job?.title || 'משרה'} | #${application.job_number}`,
    text: [
      'התקבלה מועמדות חדשה מהאתר הציבורי.',
      '',
      `משרה: ${job?.title || ''}`,
      `מספר משרה: ${application.job_number}`,
      `שם: ${application.full_name}`,
      `אימייל: ${application.email}`,
      `טלפון: ${application.phone}`,
      '',
      'תשובות לשאלות סינון:',
      answersText,
      '',
      attachmentPath ? `קובץ קו"ח מצורף למייל.` : 'לא צורף קובץ קו"ח.',
      `Application UUID: ${application.application_uuid}`,
    ].join('\n'),
    html: `
      <div dir="rtl" style="direction:rtl; text-align:right; font-family:Arial,Helvetica,sans-serif; color:#111827; line-height:1.7;">
        <div style="font-size:18px; font-weight:700; margin-bottom:16px;">התקבלה מועמדות חדשה מהאתר הציבורי.</div>
        <div style="margin-bottom:8px;"><strong>משרה:</strong> ${escapeHtml(job?.title || '')}</div>
        <div style="margin-bottom:8px;"><strong>מספר משרה:</strong> ${escapeHtml(application.job_number)}</div>
        <div style="margin-bottom:8px;"><strong>שם:</strong> ${escapeHtml(application.full_name)}</div>
        <div style="margin-bottom:8px;"><strong>אימייל:</strong> ${escapeHtml(application.email)}</div>
        <div style="margin-bottom:8px;"><strong>טלפון:</strong> ${escapeHtml(application.phone)}</div>
        <div style="margin:24px 0 12px; font-weight:700;">תשובות לשאלות סינון:</div>
        ${answersHtml}
        <div style="margin-top:24px;">${escapeHtml(attachmentPath ? 'קובץ קו"ח מצורף למייל.' : 'לא צורף קובץ קו"ח.')}</div>
        <div style="margin-top:8px; color:#6b7280;">Application UUID: ${escapeHtml(application.application_uuid)}</div>
      </div>
    `,
    attachments: attachmentPath && fs.existsSync(attachmentPath)
      ? [{
          filename: attachmentFilename,
          path: attachmentPath,
          contentType: 'application/pdf',
        }]
      : [],
  };

  await mailTransporter.sendMail(mailOptions);
  return { sent: true };
}

async function convertDocToPdfViaRemote(sourcePath, originalFilename) {
  const formData = new FormData();
  const fileBuffer = fs.readFileSync(sourcePath);
  formData.append(
    'file',
    new Blob([fileBuffer], { type: 'application/msword' }),
    originalFilename || path.basename(sourcePath)
  );

  const headers = {};
  if (DOC_PDF_CONVERTER_KEY) {
    headers['x-base44-app-key'] = DOC_PDF_CONVERTER_KEY;
  }

  const response = await fetch(DOC_PDF_CONVERTER_URL, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Remote conversion failed: ${errorText || response.status}`);
  }

  const pdfBuffer = Buffer.from(await response.arrayBuffer());
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-remote-pdf-'));
  const pdfPath = path.join(
    tmpDir,
    `${path.basename(originalFilename || sourcePath, path.extname(originalFilename || sourcePath))}.pdf`
  );
  fs.writeFileSync(pdfPath, pdfBuffer);
  return pdfPath;
}

function requireSyncSecret(req, res, next) {
  if (!SYNC_SECRET) {
    return res.status(500).json({ success: false, message: 'PUBLIC_SYNC_SECRET is not configured' });
  }
  if (req.headers['x-sync-secret'] !== SYNC_SECRET) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  next();
}

app.get('/api/sync/applications', requireSyncSecret, (req, res) => {
  const rows = db.prepare(`
    SELECT
      a.application_uuid,
      a.job_uuid,
      a.job_number,
      a.position_id,
      a.full_name,
      a.email,
      a.phone,
      a.screening_answers,
      a.cv_original_name,
      a.cv_file_path,
      a.cv_file_type,
      a.noresume,
      a.created_at,
      j.title AS job_title
    FROM applications a
    LEFT JOIN public_jobs j ON j.job_number = a.job_number
    ORDER BY datetime(a.created_at) DESC, a.id DESC
  `).all();

  res.json({ success: true, count: rows.length, data: rows });
});

app.post('/api/sync/applications/delete', requireSyncSecret, (req, res) => {
  const applicationUuids = Array.isArray(req.body.application_uuids) ? req.body.application_uuids : null;
  if (!applicationUuids) {
    return res.status(400).json({ success: false, message: 'application_uuids array is required' });
  }

  const existingRows = db.prepare(`
    SELECT application_uuid, cv_file_path
    FROM applications
    WHERE application_uuid = ?
  `);
  const deleteStmt = db.prepare('DELETE FROM applications WHERE application_uuid = ?');

  let deleted = 0;
  const tx = db.transaction((uuids) => {
    for (const applicationUuid of uuids) {
      const row = existingRows.get(applicationUuid);
      if (!row) continue;
      const result = deleteStmt.run(applicationUuid);
      if (result.changes > 0) {
        deleted += result.changes;
        cleanupCvFileIfUnused(row.cv_file_path);
      }
    }
  });

  tx(applicationUuids);
  return res.json({ success: true, deleted });
});

app.post('/api/sync/jobs', requireSyncSecret, (req, res) => {
  const upserts = Array.isArray(req.body.upserts) ? req.body.upserts : null;
  const deletedJobNumbers = Array.isArray(req.body.deleted_job_numbers) ? req.body.deleted_job_numbers : [];
  if (!upserts) {
    return res.status(400).json({ success: false, message: 'upserts array is required' });
  }

  const upsert = db.prepare(`
    INSERT INTO public_jobs (
      uuid, job_number, title, description,
      is_hot, is_sticky, is_quick_apply, show_updated_date,
      embedding_statements, position_id, category, location, job_type, scope,
      position_status, internal_salary, screening_questions, created_at, updated_at
    ) VALUES (
      @uuid, @job_number, @title, @description,
      @is_hot, @is_sticky, @is_quick_apply, @show_updated_date,
      @embedding_statements, @position_id, @category, @location, @job_type, @scope,
      @position_status, @internal_salary, @screening_questions, @created_at, @updated_at
    )
    ON CONFLICT(job_number) DO UPDATE SET
      uuid=excluded.uuid,
      title=excluded.title,
      description=excluded.description,
      is_hot=excluded.is_hot,
      is_sticky=excluded.is_sticky,
      is_quick_apply=excluded.is_quick_apply,
      show_updated_date=excluded.show_updated_date,
      embedding_statements=excluded.embedding_statements,
      position_id=excluded.position_id,
      category=excluded.category,
      location=excluded.location,
      job_type=excluded.job_type,
      scope=excluded.scope,
      position_status=excluded.position_status,
      internal_salary=excluded.internal_salary,
      screening_questions=excluded.screening_questions,
      created_at=excluded.created_at,
      updated_at=excluded.updated_at,
      original_job_number=NULL,
      job_source=NULL,
      is_preferred=0,
      svt_url=NULL,
      manager_name=NULL,
      company_description=NULL,
      job_description=NULL,
      share_link=NULL,
      publish_date=NULL
  `);
  const deleteStmt = db.prepare('DELETE FROM public_jobs WHERE job_number = ?');
  const cleanupUnusedFieldsStmt = db.prepare(`
    UPDATE public_jobs SET
      original_job_number = NULL,
      job_source = NULL,
      is_preferred = 0,
      svt_url = NULL,
      manager_name = NULL,
      company_description = NULL,
      job_description = NULL,
      share_link = NULL,
      publish_date = NULL
  `);

  const syncTx = db.transaction((rows, deletedRows) => {
    for (const row of rows) {
      upsert.run({
        uuid: row.uuid || null,
        job_number: row.job_number || null,
        title: row.title || null,
        description: row.description || null,
        is_hot: row.is_hot ? 1 : 0,
        is_sticky: row.is_sticky ? 1 : 0,
        is_quick_apply: row.is_quick_apply ? 1 : 0,
        show_updated_date: row.show_updated_date !== false ? 1 : 0,
        embedding_statements: row.embedding_statements || null,
        position_id: row.position_id || null,
        category: row.category || null,
        location: row.location || null,
        job_type: row.job_type || null,
        scope: row.scope || null,
        position_status: row.position_status || null,
        internal_salary: row.internal_salary || null,
        screening_questions: row.screening_questions || null,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
      });
    }
    for (const jobNumber of deletedRows) {
      deleteStmt.run(jobNumber);
    }
    cleanupUnusedFieldsStmt.run();
  });

  syncTx(upserts, deletedJobNumbers);
  res.json({ success: true, imported: upserts.length, deleted: deletedJobNumbers.length });
});

app.post('/api/sync/jobs/delete-all', requireSyncSecret, (req, res) => {
  const deleteStmt = db.prepare('DELETE FROM public_jobs');
  const result = deleteStmt.run();
  res.json({ success: true, deleted: Number(result.changes || 0) });
});

app.get('/api/jobs', (req, res) => {
  const { category, location, search } = req.query;
  let query = 'SELECT * FROM public_jobs WHERE 1=1';
  const params = [];

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }
  if (location) {
    query += ' AND location = ?';
    params.push(location);
  }
  if (search) {
    query += ' AND (title LIKE ? OR description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY updated_at DESC';
  const rows = db.prepare(query).all(...params);
  res.json({ success: true, count: rows.length, data: rows });
});

app.get('/api/jobs/by-number/:jobNumber', (req, res) => {
  const row = db.prepare('SELECT * FROM public_jobs WHERE job_number = ? LIMIT 1').get(req.params.jobNumber);
  if (!row) return res.status(404).json({ success: false, message: 'Job not found' });
  res.json({ success: true, data: row });
});

app.get('/api/positions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM public_jobs WHERE position_id = ? LIMIT 1').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, data: row });
});

app.get('/api/categories', (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT TRIM(category) AS value
    FROM public_jobs
    WHERE category IS NOT NULL AND TRIM(category) != ''
    ORDER BY value COLLATE NOCASE ASC
  `).all();
  res.json({ success: true, data: rows.map(r => r.value) });
});

app.get('/api/locations', (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT TRIM(location) AS value
    FROM public_jobs
    WHERE location IS NOT NULL AND TRIM(location) != ''
    ORDER BY value COLLATE NOCASE ASC
  `).all();
  res.json({ success: true, data: rows.map(r => r.value) });
});

app.post('/api/applications', upload.single('cv'), async (req, res) => {
  let uploadResult = null;

  try {
    const {
      job_uuid,
      job_number,
      position_id,
      full_name,
      email,
      phone,
      screening_answers,
      noresume,
    } = req.body;

    const noResume = normalizeBoolean(noresume);

    if (!job_number) {
      return res.status(400).json({ success: false, message: 'job_number is required' });
    }
    if (!full_name?.trim()) {
      return res.status(400).json({ success: false, message: 'full_name is required' });
    }
    if (!email?.trim() || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required' });
    }
    if (!phone?.trim()) {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }

    const job = db.prepare('SELECT uuid, job_number, position_id FROM public_jobs WHERE job_number = ? LIMIT 1').get(job_number);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    if (!noResume) {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'Resume file is required' });
      }
      uploadResult = await persistResumeFile(req.file, full_name);
    }

    const applicationUuid = crypto.randomUUID();
    db.prepare(`
      INSERT INTO applications (
        application_uuid, job_uuid, job_number, position_id, full_name, email, phone,
        screening_answers, cv_original_name, cv_file_path, cv_file_type, noresume
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      applicationUuid,
      job_uuid || job.uuid,
      job.job_number,
      position_id || job.position_id || null,
      full_name.trim(),
      email.trim(),
      phone.trim(),
      screening_answers || null,
      uploadResult?.originalName || null,
      uploadResult?.storedPath || null,
      uploadResult?.fileType || null,
      noResume ? 1 : 0
    );

    const savedApplication = {
      application_uuid: applicationUuid,
      job_uuid: job_uuid || job.uuid,
      job_number: job.job_number,
      position_id: position_id || job.position_id || null,
      full_name: full_name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      screening_answers: screening_answers || null,
      cv_original_name: uploadResult?.originalName || null,
      cv_file_path: uploadResult?.storedPath || null,
      cv_file_type: uploadResult?.fileType || null,
      noresume: noResume ? 1 : 0,
    };

    let emailNotification = { sent: false, skipped: true };
    try {
      emailNotification = await sendApplicationNotification({
        application: savedApplication,
        job: db.prepare('SELECT title FROM public_jobs WHERE job_number = ? LIMIT 1').get(job.job_number),
      });
    } catch (mailError) {
      console.error('Application email notification error:', mailError.message);
      emailNotification = { sent: false, skipped: false, error: mailError.message };
    }

    res.json({
      success: true,
      application_uuid: applicationUuid,
      message: 'Application submitted successfully',
      email_notification: emailNotification,
    });
  } catch (error) {
    console.error('Public application submission error:', error.message);
    res.status(500).json({ success: false, message: error.message || 'Application submission failed' });
  } finally {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/j', (req, res) => res.sendFile(path.join(__dirname, 'public', 'job.html')));

app.listen(PORT, () => {
  console.log(`\n✅ Public jobs server running at http://localhost:${PORT}`);
  console.log(`🌐 Home:      http://localhost:${PORT}`);
  console.log(`🧾 Job page:  http://localhost:${PORT}/j?n=123456\n`);
});
