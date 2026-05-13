const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { formidable } = require('formidable');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PUBLIC_SYNC_SECRET = process.env.PUBLIC_SYNC_SECRET || process.env.SYNC_SECRET || '';
const DOC_PDF_CONVERTER_URL = process.env.DOC_PDF_CONVERTER_URL || '';
const DOC_PDF_CONVERTER_KEY = process.env.DOC_PDF_CONVERTER_KEY || '';
const APPLICATION_NOTIFY_TO = process.env.APPLICATION_NOTIFY_TO || 'cv@djob.agency';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'no-reply@localhost';
const JOBS_TABLE = process.env.SUPABASE_PUBLIC_JOBS_TABLE || 'djob_public_jobs';
const APPLICATIONS_TABLE = process.env.SUPABASE_PUBLIC_APPLICATIONS_TABLE || 'djob_public_applications';
const RESUMES_BUCKET = process.env.SUPABASE_PUBLIC_RESUMES_BUCKET || 'djob-public-resumes';
const MAX_RESUME_BYTES = Number(process.env.PUBLIC_MAX_RESUME_BYTES || 4 * 1024 * 1024);
const SUPABASE_PAGE_SIZE = 1000;

let supabaseClient = null;
let bucketPromise = null;

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

function getSupabaseAdmin() {
  if (supabaseClient) return supabaseClient;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return supabaseClient;
}

async function ensureResumesBucket() {
  if (bucketPromise) return bucketPromise;

  bucketPromise = (async () => {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.listBuckets();
    if (error) {
      throw new Error(`Failed to list storage buckets: ${error.message}`);
    }

    if (!Array.isArray(data) || !data.some((bucket) => bucket.name === RESUMES_BUCKET)) {
      const { error: createError } = await supabase.storage.createBucket(RESUMES_BUCKET, {
        public: false,
        fileSizeLimit: String(MAX_RESUME_BYTES),
        allowedMimeTypes: ['application/pdf'],
      });
      if (createError && !/already exists/i.test(createError.message || '')) {
        throw new Error(`Failed to create resumes bucket: ${createError.message}`);
      }
    }
  })().catch((error) => {
    bucketPromise = null;
    throw error;
  });

  return bucketPromise;
}

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

function json(res, statusCode, payload) {
  setNoStoreHeaders(res);
  res.status(statusCode).json(payload);
}

function methodNotAllowed(res, methods) {
  res.setHeader('Allow', methods.join(', '));
  return json(res, 405, { success: false, message: `Method not allowed. Use ${methods.join(', ')}` });
}

function getParam(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return false;
}

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function safeBaseName(value) {
  return String(value || '')
    .trim()
    .replace(/[^\w.\-()\u0590-\u05FF ]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '') || 'resume';
}

function toStorageSafeSegment(value) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'resume';
}

function sanitizeOriginalFilename(value) {
  return safeBaseName(path.basename(String(value || 'resume.pdf')));
}

function getFileExtension(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function validateResumeMeta(file) {
  if (!file) return 'Resume file is required';
  const extension = getFileExtension(file.originalFilename || file.newFilename || file.filepath || '');
  if (!['.pdf', '.doc', '.docx'].includes(extension)) {
    return 'Only PDF, DOC, or DOCX files are allowed';
  }
  if (Number(file.size || 0) > MAX_RESUME_BYTES) {
    return `Resume file exceeds ${Math.floor(MAX_RESUME_BYTES / 1024 / 1024)}MB limit`;
  }
  return '';
}

function buildResumeStoragePath(fullName, originalName) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const sourceBase = fullName || path.basename(originalName || 'resume.pdf', path.extname(originalName || 'resume.pdf'));
  const base = toStorageSafeSegment(sourceBase).slice(0, 80);
  return `applications/${year}/${month}/${crypto.randomUUID()}-${base}.pdf`;
}

async function parseMultipartRequest(req) {
  return await new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      maxFileSize: MAX_RESUME_BYTES,
      allowEmptyFiles: true,
      keepExtensions: true,
    });

    form.parse(req, (error, fields, files) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ fields, files });
    });
  });
}

function firstFieldValue(fields, key) {
  const value = fields?.[key];
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function firstFileValue(files, key) {
  const value = files?.[key];
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

async function convertDocBufferToPdf(fileBuffer, originalFilename) {
  if (!DOC_PDF_CONVERTER_URL) {
    throw new Error('DOC and DOCX files require DOC_PDF_CONVERTER_URL to convert to PDF on Vercel.');
  }

  const extension = getFileExtension(originalFilename);
  const contentType = extension === '.docx'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'application/msword';

  const formData = new FormData();
  formData.append(
    'file',
    new Blob([fileBuffer], { type: contentType }),
    originalFilename || (extension === '.docx' ? 'resume.docx' : 'resume.doc')
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

  return Buffer.from(await response.arrayBuffer());
}

async function uploadResumeFile({ file, fullName }) {
  if (!file) return null;

  const validationError = validateResumeMeta(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const originalName = sanitizeOriginalFilename(file.originalFilename || 'resume.pdf');
  const extension = getFileExtension(originalName);
  const uploadedBuffer = fs.readFileSync(file.filepath);
  const pdfBuffer = extension === '.pdf'
    ? uploadedBuffer
    : await convertDocBufferToPdf(uploadedBuffer, originalName);

  await ensureResumesBucket();

  const storagePath = buildResumeStoragePath(fullName, originalName);
  const { error } = await getSupabaseAdmin()
    .storage
    .from(RESUMES_BUCKET)
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (error) {
    throw new Error(`Failed to upload resume: ${error.message}`);
  }

  return {
    storedPath: storagePath,
    originalName,
    fileType: 'pdf',
    pdfBuffer,
  };
}

function parseScreeningAnswers(screeningAnswers) {
  if (!screeningAnswers) return [];
  if (Array.isArray(screeningAnswers)) return screeningAnswers;
  try {
    const parsed = JSON.parse(screeningAnswers);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendApplicationNotification({ application, jobTitle, attachment }) {
  if (!mailTransporter) {
    return { sent: false, skipped: true };
  }

  const answers = parseScreeningAnswers(application.screening_answers);
  const answersText = answers.length
    ? answers.map((item, index) => {
        const answerText = typeof item === 'string'
          ? item
          : String(item?.answer || item?.value || '').trim();
        return `${index + 1}. ${answerText || '(blank)'}`;
      }).join('\n')
    : 'No screening answers provided.';

  const answersHtml = answers.length
    ? `<ol style="padding-right:18px; margin:0;">${answers.map((item) => {
        const answerText = typeof item === 'string'
          ? item
          : String(item?.answer || item?.value || '').trim();
        return `<li style="margin-bottom:8px;">${escapeHtml(answerText || '(blank)')}</li>`;
      }).join('')}</ol>`
    : '<div>לא נמסרו תשובות לשאלות סינון.</div>';

  await mailTransporter.sendMail({
    from: SMTP_FROM,
    to: APPLICATION_NOTIFY_TO,
    subject: `מועמדות חדשה למשרה ${application.job_number}${jobTitle ? ` - ${jobTitle}` : ''}`,
    text: [
      'התקבלה מועמדות חדשה מהאתר הציבורי.',
      '',
      `משרה: ${jobTitle || ''}`,
      `מספר משרה: ${application.job_number}`,
      `שם: ${application.full_name}`,
      `אימייל: ${application.email}`,
      `טלפון: ${application.phone}`,
      '',
      'תשובות לשאלות סינון:',
      answersText,
      '',
      attachment?.pdfBuffer ? 'קובץ קו"ח מצורף למייל.' : 'לא צורף קובץ קו"ח.',
      `Application UUID: ${application.application_uuid}`,
    ].join('\n'),
    html: `
      <div dir="rtl" style="direction:rtl; text-align:right; font-family:Arial,Helvetica,sans-serif; color:#111827; line-height:1.7;">
        <div style="font-size:18px; font-weight:700; margin-bottom:16px;">התקבלה מועמדות חדשה מהאתר הציבורי.</div>
        <div style="margin-bottom:8px;"><strong>משרה:</strong> ${escapeHtml(jobTitle || '')}</div>
        <div style="margin-bottom:8px;"><strong>מספר משרה:</strong> ${escapeHtml(application.job_number)}</div>
        <div style="margin-bottom:8px;"><strong>שם:</strong> ${escapeHtml(application.full_name)}</div>
        <div style="margin-bottom:8px;"><strong>אימייל:</strong> ${escapeHtml(application.email)}</div>
        <div style="margin-bottom:8px;"><strong>טלפון:</strong> ${escapeHtml(application.phone)}</div>
        <div style="margin:24px 0 12px; font-weight:700;">תשובות לשאלות סינון:</div>
        ${answersHtml}
        <div style="margin-top:24px;">${escapeHtml(attachment?.pdfBuffer ? 'קובץ קו"ח מצורף למייל.' : 'לא צורף קובץ קו"ח.')}</div>
        <div style="margin-top:8px; color:#6b7280;">Application UUID: ${escapeHtml(application.application_uuid)}</div>
      </div>
    `,
    attachments: attachment?.pdfBuffer
      ? [{
          filename: `${path.basename(attachment.originalName || 'resume', path.extname(attachment.originalName || 'resume'))}.pdf`,
          content: attachment.pdfBuffer,
          contentType: 'application/pdf',
        }]
      : [],
  });

  return { sent: true };
}

function normalizeJobRow(row) {
  return {
    uuid: normalizeText(row.uuid),
    job_number: normalizeText(row.job_number),
    title: normalizeText(row.title),
    description: normalizeText(row.description),
    is_hot: normalizeBoolean(row.is_hot),
    is_sticky: normalizeBoolean(row.is_sticky),
    is_quick_apply: normalizeBoolean(row.is_quick_apply),
    show_updated_date: row.show_updated_date === undefined || row.show_updated_date === null
      ? true
      : normalizeBoolean(row.show_updated_date),
    embedding_statements: normalizeText(row.embedding_statements),
    position_id: normalizeText(row.position_id),
    category: normalizeText(row.category),
    location: normalizeText(row.location),
    job_type: normalizeText(row.job_type),
    job_role: normalizeText(row.job_role),
    scope: normalizeText(row.scope),
    publish_date: normalizeText(row.publish_date),
    position_status: normalizeText(row.position_status),
    internal_salary: normalizeText(row.internal_salary),
    screening_questions: normalizeText(row.screening_questions),
    created_at: normalizeText(row.created_at),
    updated_at: normalizeText(row.updated_at) || new Date().toISOString(),
  };
}

function normalizeSyncTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

async function fetchAllTableRows(buildPageQuery) {
  const rows = [];
  let from = 0;

  while (true) {
    const to = from + SUPABASE_PAGE_SIZE - 1;
    const { data, error } = await buildPageQuery(from, to);
    if (error) {
      throw error;
    }

    const pageRows = Array.isArray(data) ? data : [];
    rows.push(...pageRows);

    if (pageRows.length < SUPABASE_PAGE_SIZE) {
      break;
    }

    from += SUPABASE_PAGE_SIZE;
  }

  return rows;
}

async function listJobs({ category, location, search }) {
  const rows = await fetchAllTableRows((from, to) => {
    let query = getSupabaseAdmin()
      .from(JOBS_TABLE)
      .select('*')
      .order('updated_at', { ascending: false })
      .range(from, to);

    if (category) query = query.eq('category', category);
    if (location) query = query.eq('location', location);

    return query;
  }).catch((error) => {
    throw new Error(`Failed to load jobs: ${error.message}`);
  });

  let filteredRows = Array.isArray(rows) ? rows : [];
  if (search) {
    const needle = String(search).trim().toLowerCase();
    filteredRows = filteredRows.filter((row) =>
      [row.title, row.description, row.category, row.location, row.job_role, row.job_number, row.position_id]
        .map((value) => String(value || '').toLowerCase())
        .some((value) => value.includes(needle))
    );
  }

  return filteredRows;
}

async function getJobByNumber(jobNumber) {
  const { data, error } = await getSupabaseAdmin()
    .from(JOBS_TABLE)
    .select('*')
    .eq('job_number', jobNumber)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load job: ${error.message}`);
  }
  return data || null;
}

async function getJobByPositionId(positionId) {
  const { data, error } = await getSupabaseAdmin()
    .from(JOBS_TABLE)
    .select('*')
    .eq('position_id', positionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load position: ${error.message}`);
  }
  return data || null;
}

async function listDistinctValues(columnName) {
  const data = await fetchAllTableRows((from, to) => (
    getSupabaseAdmin()
      .from(JOBS_TABLE)
      .select(columnName)
      .range(from, to)
  )).catch((error) => {
    throw new Error(`Failed to load ${columnName}: ${error.message}`);
  });

  const values = new Set();
  for (const row of data || []) {
    const value = String(row?.[columnName] || '').trim();
    if (value) values.add(value);
  }
  return Array.from(values).sort((a, b) => a.localeCompare(b, 'he'));
}

async function syncJobs(upserts, deletedJobNumbers, syncedAtRaw) {
  const normalizedRows = upserts
    .map(normalizeJobRow)
    .filter((row) => row.job_number);
  const syncedAt = normalizeSyncTimestamp(syncedAtRaw);

  if (normalizedRows.length) {
    const rowsWithPositionId = normalizedRows.filter((row) => String(row.position_id || '').trim());
    const rowsWithoutPositionId = normalizedRows.filter((row) => !String(row.position_id || '').trim());
    const existingByPositionId = new Map();
    const existingByJobNumber = new Map();

    if (rowsWithPositionId.length) {
      const { data, error } = await getSupabaseAdmin()
        .from(JOBS_TABLE)
        .select('position_id, job_number, publish_date, created_at')
        .in('position_id', rowsWithPositionId.map((row) => row.position_id));
      if (error) {
        throw new Error(`Failed to load existing public jobs by position: ${error.message}`);
      }
      for (const row of data || []) {
        if (row?.position_id) existingByPositionId.set(String(row.position_id), row);
        if (row?.job_number) existingByJobNumber.set(String(row.job_number), row);
      }
    }

    if (rowsWithoutPositionId.length) {
      const { data, error } = await getSupabaseAdmin()
        .from(JOBS_TABLE)
        .select('position_id, job_number, publish_date, created_at')
        .in('job_number', rowsWithoutPositionId.map((row) => row.job_number));
      if (error) {
        throw new Error(`Failed to load existing public jobs by job number: ${error.message}`);
      }
      for (const row of data || []) {
        if (row?.position_id) existingByPositionId.set(String(row.position_id), row);
        if (row?.job_number) existingByJobNumber.set(String(row.job_number), row);
      }
    }

    const hydratedRows = normalizedRows.map((row) => {
      const existing = (row.position_id && existingByPositionId.get(String(row.position_id)))
        || existingByJobNumber.get(String(row.job_number))
        || null;
      return {
        ...row,
        publish_date: existing?.publish_date || syncedAt,
        updated_at: syncedAt,
        created_at: existing?.created_at || row.created_at || syncedAt,
      };
    });

    const hydratedRowsWithPositionId = hydratedRows.filter((row) => String(row.position_id || '').trim());
    const hydratedRowsWithoutPositionId = hydratedRows.filter((row) => !String(row.position_id || '').trim());

    if (hydratedRowsWithPositionId.length) {
      const { error } = await getSupabaseAdmin()
        .from(JOBS_TABLE)
        .upsert(hydratedRowsWithPositionId, { onConflict: 'position_id' });
      if (error) {
        throw new Error(`Failed to sync jobs: ${error.message}`);
      }
    }

    if (hydratedRowsWithoutPositionId.length) {
      const { error } = await getSupabaseAdmin()
        .from(JOBS_TABLE)
        .upsert(hydratedRowsWithoutPositionId, { onConflict: 'job_number' });
      if (error) {
        throw new Error(`Failed to sync jobs without position_id: ${error.message}`);
      }
    }
  }

  if (deletedJobNumbers.length) {
    const { error } = await getSupabaseAdmin()
      .from(JOBS_TABLE)
      .delete()
      .in('job_number', deletedJobNumbers);
    if (error) {
      throw new Error(`Failed to delete public jobs: ${error.message}`);
    }
  }

  return {
    imported: normalizedRows.length,
    deleted: deletedJobNumbers.length,
  };
}

async function deleteAllJobs() {
  const { error } = await getSupabaseAdmin()
    .from(JOBS_TABLE)
    .delete()
    .not('job_number', 'is', null);
  if (error) {
    throw new Error(`Failed to delete all jobs: ${error.message}`);
  }
}

async function createApplicationFromRequest(req) {
  const { fields, files } = await parseMultipartRequest(req);
  const fullName = String(firstFieldValue(fields, 'full_name') || '').trim();
  const email = String(firstFieldValue(fields, 'email') || '').trim();
  const phone = String(firstFieldValue(fields, 'phone') || '').trim();
  const jobNumber = String(firstFieldValue(fields, 'job_number') || '').trim();
  const noResume = normalizeBoolean(firstFieldValue(fields, 'noresume'));
  const screeningAnswers = firstFieldValue(fields, 'screening_answers') || null;
  const uploadedFile = firstFileValue(files, 'cv');

  try {
    if (!jobNumber) throw new Error('job_number is required');
    if (!fullName) throw new Error('full_name is required');
    if (!email || !email.includes('@')) throw new Error('Valid email is required');
    if (!phone) throw new Error('phone is required');

    const job = await getJobByNumber(jobNumber);
    if (!job) {
      const error = new Error('Job not found');
      error.statusCode = 404;
      throw error;
    }

    if (!noResume && !uploadedFile) {
      throw new Error('Resume file is required');
    }

    const uploadResult = noResume ? null : await uploadResumeFile({ file: uploadedFile, fullName });
    const applicationUuid = crypto.randomUUID();
    const row = {
      application_uuid: applicationUuid,
      job_uuid: normalizeText(firstFieldValue(fields, 'job_uuid')) || job.uuid || null,
      job_number: job.job_number,
      position_id: normalizeText(firstFieldValue(fields, 'position_id')) || job.position_id || null,
      full_name: fullName,
      email,
      phone,
      screening_answers: screeningAnswers,
      cv_original_name: uploadResult?.originalName || null,
      cv_file_path: uploadResult?.storedPath || null,
      cv_file_type: uploadResult?.fileType || null,
      noresume: noResume,
      created_at: new Date().toISOString(),
    };

    const { error } = await getSupabaseAdmin()
      .from(APPLICATIONS_TABLE)
      .insert(row);
    if (error) {
      throw new Error(`Failed to save application: ${error.message}`);
    }

    let emailNotification = { sent: false, skipped: true };
    try {
      emailNotification = await sendApplicationNotification({
        application: row,
        jobTitle: job.title || '',
        attachment: uploadResult,
      });
    } catch (mailError) {
      emailNotification = { sent: false, skipped: false, error: mailError.message };
    }

    return {
      success: true,
      application_uuid: applicationUuid,
      message: 'Application submitted successfully',
      email_notification: emailNotification,
    };
  } finally {
    if (uploadedFile?.filepath && fs.existsSync(uploadedFile.filepath)) {
      fs.unlinkSync(uploadedFile.filepath);
    }
  }
}

async function listSyncApplications() {
  const { data, error } = await getSupabaseAdmin()
    .from(APPLICATIONS_TABLE)
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch public applications: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data : [];
  const jobNumbers = Array.from(new Set(rows.map((row) => row.job_number).filter(Boolean)));
  const titleMap = new Map();

  if (jobNumbers.length) {
    const { data: jobs, error: jobsError } = await getSupabaseAdmin()
      .from(JOBS_TABLE)
      .select('job_number, title')
      .in('job_number', jobNumbers);
    if (jobsError) {
      throw new Error(`Failed to fetch job titles: ${jobsError.message}`);
    }
    for (const job of jobs || []) {
      titleMap.set(job.job_number, job.title || '');
    }
  }

  return rows.map((row) => ({
    ...row,
    job_title: titleMap.get(row.job_number) || '',
  }));
}

async function cleanupStoragePathIfUnused(storagePath) {
  if (!storagePath) return;
  const { count, error } = await getSupabaseAdmin()
    .from(APPLICATIONS_TABLE)
    .select('id', { head: true, count: 'exact' })
    .eq('cv_file_path', storagePath);

  if (error) {
    throw new Error(`Failed to verify storage usage: ${error.message}`);
  }
  if (Number(count || 0) > 0) return;

  const { error: removeError } = await getSupabaseAdmin()
    .storage
    .from(RESUMES_BUCKET)
    .remove([storagePath]);
  if (removeError && !/not found/i.test(removeError.message || '')) {
    throw new Error(`Failed to delete resume from storage: ${removeError.message}`);
  }
}

async function deleteSyncApplications(applicationUuids) {
  const cleaned = Array.from(new Set(applicationUuids.map((value) => String(value || '').trim()).filter(Boolean)));
  if (!cleaned.length) {
    return { deleted: 0 };
  }

  const { data: existingRows, error: existingError } = await getSupabaseAdmin()
    .from(APPLICATIONS_TABLE)
    .select('application_uuid, cv_file_path')
    .in('application_uuid', cleaned);

  if (existingError) {
    throw new Error(`Failed to fetch applications before deletion: ${existingError.message}`);
  }

  const existing = Array.isArray(existingRows) ? existingRows : [];
  if (!existing.length) {
    return { deleted: 0 };
  }

  const { error: deleteError } = await getSupabaseAdmin()
    .from(APPLICATIONS_TABLE)
    .delete()
    .in('application_uuid', existing.map((row) => row.application_uuid));

  if (deleteError) {
    throw new Error(`Failed to delete applications: ${deleteError.message}`);
  }

  const uniquePaths = Array.from(new Set(existing.map((row) => row.cv_file_path).filter(Boolean)));
  for (const storagePath of uniquePaths) {
    await cleanupStoragePathIfUnused(storagePath);
  }

  return { deleted: existing.length };
}

async function downloadApplicationResume(applicationUuid) {
  const { data: row, error } = await getSupabaseAdmin()
    .from(APPLICATIONS_TABLE)
    .select('application_uuid, cv_file_path, cv_original_name, full_name')
    .eq('application_uuid', applicationUuid)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch application resume: ${error.message}`);
  }
  if (!row?.cv_file_path) {
    const notFound = new Error('Resume file not found');
    notFound.statusCode = 404;
    throw notFound;
  }

  const { data, error: downloadError } = await getSupabaseAdmin()
    .storage
    .from(RESUMES_BUCKET)
    .download(row.cv_file_path);

  if (downloadError) {
    const notFound = new Error(`Failed to download resume: ${downloadError.message}`);
    notFound.statusCode = /not found/i.test(downloadError.message || '') ? 404 : 500;
    throw notFound;
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  const original = sanitizeOriginalFilename(row.cv_original_name || `${row.full_name || 'resume'}.pdf`);
  const filename = `${path.basename(original, path.extname(original))}.pdf`;

  return {
    buffer,
    filename,
    originalName: row.cv_original_name || filename,
  };
}

function verifySyncSecret(req, res) {
  if (!PUBLIC_SYNC_SECRET) {
    json(res, 500, { success: false, message: 'PUBLIC_SYNC_SECRET is not configured' });
    return false;
  }
  if (req.headers['x-sync-secret'] !== PUBLIC_SYNC_SECRET) {
    json(res, 403, { success: false, message: 'Forbidden' });
    return false;
  }
  return true;
}

async function handleGetJobs(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const rows = await listJobs({
      category: getParam(req.query.category),
      location: getParam(req.query.location),
      search: getParam(req.query.search),
    });
    return json(res, 200, { success: true, count: rows.length, data: rows });
  } catch (error) {
    return json(res, 500, { success: false, message: error.message || 'Failed to load jobs' });
  }
}

async function handleGetJobByNumber(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const row = await getJobByNumber(getParam(req.query.jobNumber));
    if (!row) return json(res, 404, { success: false, message: 'Job not found' });
    return json(res, 200, { success: true, data: row });
  } catch (error) {
    return json(res, 500, { success: false, message: error.message || 'Failed to load job' });
  }
}

async function handleGetPositionById(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const row = await getJobByPositionId(getParam(req.query.id));
    if (!row) return json(res, 404, { success: false, message: 'Not found' });
    return json(res, 200, { success: true, data: row });
  } catch (error) {
    return json(res, 500, { success: false, message: error.message || 'Failed to load position' });
  }
}

async function handleGetCategories(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const values = await listDistinctValues('category');
    return json(res, 200, { success: true, data: values });
  } catch (error) {
    return json(res, 500, { success: false, message: error.message || 'Failed to load categories' });
  }
}

async function handleGetLocations(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const values = await listDistinctValues('location');
    return json(res, 200, { success: true, data: values });
  } catch (error) {
    return json(res, 500, { success: false, message: error.message || 'Failed to load locations' });
  }
}

async function handleCreateApplication(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const payload = await createApplicationFromRequest(req);
    return json(res, 200, payload);
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    return json(res, statusCode, { success: false, message: error.message || 'Application submission failed' });
  }
}

async function handleSyncJobs(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!verifySyncSecret(req, res)) return;

  const upserts = Array.isArray(req.body?.upserts) ? req.body.upserts : null;
  const deletedJobNumbers = Array.isArray(req.body?.deleted_job_numbers) ? req.body.deleted_job_numbers : [];
  if (!upserts) {
    return json(res, 400, { success: false, message: 'upserts array is required' });
  }

  try {
    const result = await syncJobs(upserts, deletedJobNumbers, req.body?.synced_at);
    return json(res, 200, {
      success: true,
      imported: result.imported,
      deleted: result.deleted,
    });
  } catch (error) {
    return json(res, 500, { success: false, message: error.message || 'Job sync failed' });
  }
}

async function handleDeleteAllJobs(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!verifySyncSecret(req, res)) return;

  try {
    await deleteAllJobs();
    return json(res, 200, { success: true, deleted: 'all' });
  } catch (error) {
    return json(res, 500, { success: false, message: error.message || 'Failed to delete public jobs' });
  }
}

async function handleSyncApplications(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!verifySyncSecret(req, res)) return;

  try {
    const rows = await listSyncApplications();
    return json(res, 200, { success: true, count: rows.length, data: rows });
  } catch (error) {
    return json(res, 500, { success: false, message: error.message || 'Failed to fetch public applications' });
  }
}

async function handleDeleteSyncApplications(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!verifySyncSecret(req, res)) return;

  const applicationUuids = Array.isArray(req.body?.application_uuids) ? req.body.application_uuids : null;
  if (!applicationUuids) {
    return json(res, 400, { success: false, message: 'application_uuids array is required' });
  }

  try {
    const result = await deleteSyncApplications(applicationUuids);
    return json(res, 200, { success: true, deleted: result.deleted });
  } catch (error) {
    return json(res, 500, { success: false, message: error.message || 'Failed to delete public applications' });
  }
}

async function handleDownloadSyncApplicationResume(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!verifySyncSecret(req, res)) return;

  try {
    const file = await downloadApplicationResume(getParam(req.query.applicationUuid));
    const encodedOriginalName = encodeURIComponent(String(file.originalName || file.filename || 'resume.pdf'));
    const encodedDownloadName = encodeURIComponent(String(file.filename || 'resume.pdf'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="resume.pdf"; filename*=UTF-8''${encodedDownloadName}`);
    res.setHeader('X-Original-Filename', encodedOriginalName);
    res.setHeader('X-Original-Filename-Encoding', 'uri');
    res.status(200).send(file.buffer);
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    return json(res, statusCode, { success: false, message: error.message || 'Failed to download resume' });
  }
}

module.exports = {
  MAX_RESUME_BYTES,
  handleGetJobs,
  handleGetJobByNumber,
  handleGetPositionById,
  handleGetCategories,
  handleGetLocations,
  handleCreateApplication,
  handleSyncJobs,
  handleDeleteAllJobs,
  handleSyncApplications,
  handleDeleteSyncApplications,
  handleDownloadSyncApplicationResume,
};
