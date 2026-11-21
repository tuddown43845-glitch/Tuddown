import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Shared server-side Gemini client
const createGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
};

// Simple in-memory sliding-window rate limiter per IP for /api/parse-exam
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_REQUESTS = 25;

const checkRateLimit = (ip: string): boolean => {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(ip) || []).filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitMap.set(ip, timestamps);
    return false;
  }
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return true;
};

const MCQ_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: {
            type: Type.STRING,
            description: 'The full question text without leading question number.',
          },
          options: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Array of 2 to 5 answer choice strings without leading ก./ข./A./B. labels.',
          },
          correctIndex: {
            type: Type.INTEGER,
            description: '0-based index of the correct option (0 for ก/A, 1 for ข/B, etc.), or -1 if no answer key is provided.',
          },
        },
        required: ['text', 'options', 'correctIndex'],
      },
    },
  },
  required: ['questions'],
};

const SUBJ_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: {
            type: Type.STRING,
            description: 'The full subjective/essay question text without leading question number.',
          },
        },
        required: ['text'],
      },
    },
  },
  required: ['questions'],
};

async function startServer() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Server-side AI Exam Parser (for complex Word .docx / raw text)
  app.post('/api/parse-exam', async (req, res) => {
    const clientIp = String(req.ip || req.socket.remoteAddress || 'unknown');
    if (!checkRateLimit(clientIp)) {
      res.status(429).json({
        error: 'ใช้งานตัวแกะข้อสอบด้วย AI บ่อยเกินกำหนด กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
      });
      return;
    }

    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY ใน Settings > Secrets ของระบบ กรุณาใช้โหมดอ่านไฟล์ Word ปกติหรือนำเข้าด้วย Excel แทน',
      });
      return;
    }

    const body = req.body;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' });
      return;
    }

    const rawContent = typeof body.content === 'string' ? body.content.trim() : '';
    const mode = body.mode === 'subj' ? 'subj' : 'mcq';

    if (!rawContent) {
      res.status(400).json({ error: 'ไม่พบข้อความสำหรับวิเคราะห์ข้อสอบ' });
      return;
    }

    if (rawContent.length > 120000) {
      res.status(400).json({
        error: 'เนื้อหาไฟล์ยาวเกิน 120,000 ตัวอักษร กรุณาแบ่งไฟล์ข้อสอบเป็นส่วนๆ แล้วนำเข้าทีละชุด',
      });
      return;
    }

    try {
      const systemInstruction =
        mode === 'mcq'
          ? [
              'คุณคือผู้เชี่ยวชาญการแปลงเอกสารข้อสอบภาษาไทยและภาษาอังกฤษจากไฟล์ Word ให้เป็นข้อมูลโครงสร้าง JSON ที่แม่นยำ 100%',
              'กติกาสำคัญ:',
              '1. แยกทุกข้อสอบปรนัยออกมาให้ครบตามลำดับ ไม่ตัดทอนข้อความโจทย์ และคงบทความ/สถานการณ์ที่อยู่ในโจทย์ไว้ครบถ้วน',
              '2. ตัดเลขข้อนำหน้าโจทย์ออก (เช่น "1.", "ข้อ 1", "๑.") และตัดอักษรนำหน้าตัวเลือกออก (เช่น "ก.", "ข.", "A.", "1)")',
              '3. หากตัวเลือกอยู่บรรทัดเดียวกันหลายคอลัมน์ (เช่น ก. ... ข. ...) ให้แยกเป็นแต่ละ item ใน options อย่างถูกต้อง',
              '4. สังเกตเฉลยจากทุกรูปแบบ: บรรทัด "ตอบ/เฉลย/Answer", เครื่องหมายดอกจัน (*), ข้อความที่ถูกเน้นด้วยแท็ก [BOLD] หรือ [MARK] หรือ [UNDERLINE] หรือตารางเฉลยท้ายไฟล์ แล้วแปลงเป็น correctIndex แบบ 0-based (ก=0, ข=1, ค=2, ง=3, จ=4)',
              '5. หากข้อใดไม่ปรากฏเฉลยในเอกสารเลย ให้ใส่ correctIndex เป็น -1 (ห้ามเดาเฉลยเอง)',
              '6. ข้ามหัวกระดาษ คำชี้แจงทั่วไป หรือชื่อโรงเรียนที่ไม่ใช่คำถามข้อสอบ',
            ].join('\n')
          : [
              'คุณคือผู้เชี่ยวชาญการแปลงเอกสารข้อสอบอัตนัย (ข้อเขียน) จากไฟล์ Word ให้เป็น JSON ที่แม่นยำ',
              '1. แยกคำถามอัตนัยทุกข้อออกมาให้ครบตามลำดับ โดยตัดเลขข้อนำหน้าออก (เช่น "1.", "ข้อ 1")',
              '2. คงรายละเอียดคำชี้แจงย่อย บทความ หรือกรณีศึกษาของแต่ละข้อไว้ครบถ้วน',
              '3. ข้ามหัวกระดาษ ชื่อโรงเรียน หรือบรรทัดว่างสำหรับเขียนคำตอบ (เช่น เส้นประ ........)',
            ].join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `โปรดแปลงเนื้อหาข้อสอบต่อไปนี้เป็น JSON ตาม schema ที่กำหนด:\n\n${rawContent}`,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: mode === 'mcq' ? MCQ_RESPONSE_SCHEMA : SUBJ_RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });

      const jsonText = (response.text ?? '').trim();
      if (!jsonText) {
        res.status(502).json({ error: 'AI ไม่ได้ส่งข้อมูลข้อสอบกลับมา กรุณาลองใหม่อีกครั้ง' });
        return;
      }

      const parsed = JSON.parse(jsonText);
      const rawQuestions = Array.isArray(parsed?.questions) ? parsed.questions : [];

      if (mode === 'mcq') {
        const sanitized = rawQuestions
          .filter((q: any) => q && typeof q.text === 'string' && q.text.trim().length > 0)
          .map((q: any) => {
            const options = Array.isArray(q.options)
              ? q.options
                  .map((o: any) => String(o ?? '').trim())
                  .filter(Boolean)
                  .slice(0, 5)
              : [];
            const rawIdx = typeof q.correctIndex === 'number' ? Math.floor(q.correctIndex) : -1;
            const hasAnswer = rawIdx >= 0 && rawIdx < options.length;
            return {
              text: q.text.trim(),
              options,
              correctIndex: hasAnswer ? rawIdx : 0,
              answerDetected: hasAnswer,
            };
          });

        res.json({ questions: sanitized });
      } else {
        const sanitized = rawQuestions
          .filter((q: any) => q && typeof q.text === 'string' && q.text.trim().length > 0)
          .map((q: any) => ({
            text: q.text.trim(),
          }));

        res.json({ questions: sanitized });
      }
    } catch (err: any) {
      console.error('POST /api/parse-exam error:', err);
      const status = typeof err?.status === 'number' ? err.status : 500;
      if (status === 429) {
        res.status(429).json({ error: 'โควตาการใช้งาน AI ชั่วคราวเต็ม กรุณารอสักครู่หรือใช้โหมดนำเข้า Word/Excel ปกติ' });
        return;
      }
      if (status === 401 || status === 403) {
        res.status(502).json({ error: 'ไม่สามารถยืนยันสิทธิ์ API Key ของ AI ได้ กรุณาตรวจสอบใน Settings > Secrets' });
        return;
      }
      res.status(500).json({ error: 'เกิดข้อผิดพลาดระหว่างให้ AI วิเคราะห์ไฟล์ข้อสอบ กรุณาลองใหม่อีกครั้ง' });
    }
  });

  if (isProd) {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
