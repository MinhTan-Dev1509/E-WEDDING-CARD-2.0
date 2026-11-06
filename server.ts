import dotenv from 'dotenv';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// README hướng dẫn đặt khóa trong .env.local nên nạp cả hai file (.env.local được ưu tiên).
dotenv.config({ path: '.env.local' });
dotenv.config();

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';
const AI_RATE_LIMIT_PER_MIN = Number(process.env.AI_RATE_LIMIT_PER_MIN) || 30;
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim() === '') {
    const err = new Error(
      'Chưa cấu hình GEMINI_API_KEY. Vui lòng kiểm tra khóa API trong mục Settings > Secrets.',
    );
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function parseDataUrlImage(dataUrl: string): { mimeType: string; base64Data: string } | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    base64Data: match[2].replace(/\s+/g, ''),
  };
}

function normalizeHex(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  const trimmed = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed.toUpperCase()}`;
  return fallback;
}

function extractJsonObject(rawText: string): Record<string, unknown> {
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error('Không thể đọc dữ liệu thiết kế trả về từ AI.');
  }
}

function sendAiError(res: Response, err: unknown, fallbackMessage: string): void {
  const rawMessage = err instanceof Error && err.message ? err.message : fallbackMessage;
  const message = rawMessage.length > 400 ? `${rawMessage.slice(0, 400)}…` : rawMessage;
  const rawStatus =
    (err as { statusCode?: number; status?: number })?.statusCode ||
    (err as { status?: number })?.status ||
    500;
  const statusCode =
    Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;

  console.error('[AI]', rawMessage);

  if (
    statusCode === 403 ||
    rawMessage.includes('PERMISSION_DENIED') ||
    rawMessage.includes('API_KEY_INVALID')
  ) {
    res.status(403).json({
      error:
        'Khóa Gemini API chưa hợp lệ hoặc chưa được cấp quyền. Vui lòng kiểm tra khóa API trong mục Settings > Secrets.',
    });
    return;
  }

  if (statusCode === 429 || rawMessage.includes('RESOURCE_EXHAUSTED')) {
    res.status(429).json({
      error:
        'Đã chạm giới hạn lượt gọi Gemini API hiện tại. Bạn có thể thử lại sau ít giây hoặc nâng cấp hạn mức trong Settings > Secrets.',
    });
    return;
  }

  res.status(statusCode).json({ error: message });
}

/** Giới hạn số lượt gọi theo IP (in-memory, không cần thêm thư viện) để tránh bị đốt hạn mức Gemini. */
function createRateLimiter(maxRequests: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  sweeper.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > maxRequests) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({
        error: 'Bạn thao tác quá nhanh. Vui lòng đợi ít giây rồi thử lại.',
      });
      return;
    }
    next();
  };
}

async function startServer() {
  const app = express();

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) {
    // Đặt TRUST_PROXY=1 khi chạy sau reverse proxy / Cloud Run để req.ip là IP thật của người dùng.
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
  }

  app.use(express.json({ limit: '15mb' }));
  app.use('/api/ai', createRateLimiter(AI_RATE_LIMIT_PER_MIN, 60_000));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post('/api/ai/analyze-theme', async (req: Request, res: Response) => {
    try {
      const { imageDataUrl, userHint } = (req.body ?? {}) as {
        imageDataUrl?: string;
        userHint?: string;
      };

      if (!imageDataUrl || typeof imageDataUrl !== 'string') {
        res.status(400).json({
          error: 'Vui lòng chọn một hình ảnh chủ đề (JPEG, PNG hoặc WebP) để AI phân tích.',
        });
        return;
      }

      const parsedImg = parseDataUrlImage(imageDataUrl);
      if (!parsedImg) {
        res.status(400).json({
          error: 'Định dạng dữ liệu ảnh không hợp lệ. Hãy tải lại file ảnh JPEG/PNG từ máy tính.',
        });
        return;
      }

      const ai = getGeminiClient();

      const promptText = [
        'Hãy quan sát kỹ hình ảnh mẫu chủ đề thiệp cưới này và phân tích loài hoa / họa tiết chủ đạo, bảng màu cánh hoa, màu nhụy, màu lá và sắc thái thẩm mỹ.',
        userHint && userHint.trim()
          ? `Ghi chú mong muốn thêm từ người dùng: "${userHint.trim()}".`
          : '',
        'Từ hình ảnh mẫu, hãy thiết kế một chủ đề thiệp cưới sang trọng, hài hòa (nền sáng thanh lịch đảm bảo độ tương phản chữ tối dễ đọc >= 4.5:1) và chọn kiểu đồ họa hoa (archetype) sát nhất với mẫu ảnh.',
        'Ví dụ: nếu ảnh là hoa mẫu đơn thì archetype = "peony", petalShape = "round-peony", tên chủ đề tiếng Việt có "Hoa Mẫu Đơn"; nếu là hoa hồng thì "rose"; cẩm tú cầu thì "hydrangea"; hoa ly/loa kèn thì "lily"; hoa anh đào/đào/mai cánh mỏng thì "sakura"; hoa lan thì "orchid"; hướng dương/cúc vàng thì "sunflower"; sen/súng thì "lotus"; lá xanh tối giản thì "minimal-leaf".',
      ]
        .filter(Boolean)
        .join('\n');

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: parsedImg.mimeType,
                data: parsedImg.base64Data,
              },
            },
            { text: promptText },
          ],
        },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          systemInstruction:
            'Bạn là Giám đốc Mỹ thuật Thiệp Cưới Cao Cấp tại Việt Nam. Luôn trả về JSON chính xác theo schema với mã màu HEX 6 ký tự (#RRGGBB). Giữ nền bgCanvas và bgPaper rất sáng (độ sáng > 93%) để chữ mực tối luôn rõ nét sang trọng.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              nameVi: {
                type: Type.STRING,
                description: 'Tên chủ đề tiếng Việt sang trọng, ví dụ: Hoa Mẫu Đơn Hồng Phấn',
              },
              motifLabelVi: {
                type: Type.STRING,
                description: 'Tên ngắn họa tiết rơi (2-4 chữ), ví dụ: Hoa mẫu đơn, Hoa hồng kem',
              },
              descriptionVi: {
                type: Type.STRING,
                description: 'Mô tả ngắn 1-2 câu tiếng Việt về phong cách và sắc màu đọc được từ ảnh mẫu.',
              },
              aiAnalysisSummary: {
                type: Type.STRING,
                description:
                  'Nhận xét chi tiết của AI về loài hoa, dáng cánh hoa và bảng màu trích xuất từ ảnh người dùng tải lên.',
              },
              archetype: {
                type: Type.STRING,
                description:
                  'Một trong: lotus, peony, rose, hydrangea, lily, sakura, orchid, sunflower, minimal-leaf',
              },
              petalShape: {
                type: Type.STRING,
                description:
                  'Một trong: pointed-lotus, round-peony, rose-petal, sakura-blossom, slender-leaf',
              },
              bloomPrimaryColor: {
                type: Type.STRING,
                description: 'Mã màu HEX #RRGGBB cánh hoa đậm/chính trên ảnh mẫu',
              },
              bloomSecondaryColor: {
                type: Type.STRING,
                description: 'Mã màu HEX #RRGGBB cánh hoa nhạt/phụ hoặc lớp cánh ngoài trên ảnh mẫu',
              },
              stamenColor: {
                type: Type.STRING,
                description: 'Mã màu HEX #RRGGBB nhụy hoa / tâm hoa',
              },
              bgCanvas: {
                type: Type.STRING,
                description: 'Mã màu HEX #RRGGBB nền tổng thể rất sáng (ví dụ #FFFDF9)',
              },
              bgPaper: {
                type: Type.STRING,
                description: 'Mã màu HEX #RRGGBB nền giấy thiệp sáng dịu (ví dụ #FCF6F2)',
              },
              accentPrimary: {
                type: Type.STRING,
                description: 'Mã màu HEX #RRGGBB nhấn chính cho nút bấm, chữ ký tên cô dâu chú rể',
              },
              accentDark: {
                type: Type.STRING,
                description: 'Mã màu HEX #RRGGBB nhấn đậm hơn khi hover hoặc tiêu đề phụ',
              },
              accentSoft: {
                type: Type.STRING,
                description: 'Mã màu HEX #RRGGBB pastel dịu cho trái tim lịch và viền trang trí',
              },
              accentBlush: {
                type: Type.STRING,
                description: 'Mã màu HEX #RRGGBB nền ửng nhẹ cho nút phụ và thẻ nổi bật',
              },
              foliagePrimary: {
                type: Type.STRING,
                description: 'Mã màu HEX #RRGGBB xanh lá cây chủ đạo trong bó hoa',
              },
              foliageLight: {
                type: Type.STRING,
                description: 'Mã màu HEX #RRGGBB xanh lá non / nơ lụa dịu nhẹ',
              },
            },
            required: [
              'nameVi',
              'motifLabelVi',
              'descriptionVi',
              'aiAnalysisSummary',
              'archetype',
              'petalShape',
              'bloomPrimaryColor',
              'bloomSecondaryColor',
              'stamenColor',
              'bgCanvas',
              'bgPaper',
              'accentPrimary',
              'accentDark',
              'accentSoft',
              'accentBlush',
              'foliagePrimary',
              'foliageLight',
            ],
          },
        },
      });

      const rawJson = (response.text ?? '{}').trim();
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;

      const validArchetypes = new Set([
        'lotus',
        'peony',
        'rose',
        'hydrangea',
        'lily',
        'sakura',
        'orchid',
        'sunflower',
        'minimal-leaf',
      ]);
      const validPetals = new Set([
        'pointed-lotus',
        'round-peony',
        'rose-petal',
        'sakura-blossom',
        'slender-leaf',
      ]);

      const archetype = validArchetypes.has(String(parsed.archetype))
        ? String(parsed.archetype)
        : 'peony';
      const petalShape = validPetals.has(String(parsed.petalShape))
        ? String(parsed.petalShape)
        : archetype === 'peony'
        ? 'round-peony'
        : archetype === 'sakura'
        ? 'sakura-blossom'
        : archetype === 'minimal-leaf'
        ? 'slender-leaf'
        : 'rose-petal';

      const accentPrimary = normalizeHex(parsed.accentPrimary, '#D64C73');
      const accentSoft = normalizeHex(parsed.accentSoft, '#F4A4BA');
      const bloomPrimaryColor = normalizeHex(parsed.bloomPrimaryColor, accentPrimary);
      const bloomSecondaryColor = normalizeHex(parsed.bloomSecondaryColor, '#FADADD');
      const foliageLight = normalizeHex(parsed.foliageLight, '#CFE2C9');

      res.json({
        theme: {
          nameVi:
            typeof parsed.nameVi === 'string' && parsed.nameVi.trim()
              ? parsed.nameVi.trim().slice(0, 70)
              : 'Chủ Đề Hoa Nghệ Thuật (AI)',
          motifLabelVi:
            typeof parsed.motifLabelVi === 'string' && parsed.motifLabelVi.trim()
              ? parsed.motifLabelVi.trim().slice(0, 32)
              : 'Cánh hoa',
          descriptionVi:
            typeof parsed.descriptionVi === 'string' && parsed.descriptionVi.trim()
              ? parsed.descriptionVi.trim()
              : 'Chủ đề được AI phân tích và phối màu trực tiếp từ hình ảnh mẫu của bạn.',
          aiAnalysisSummary:
            typeof parsed.aiAnalysisSummary === 'string' && parsed.aiAnalysisSummary.trim()
              ? parsed.aiAnalysisSummary.trim()
              : 'Đã nhận diện bố cục hoa và bảng màu chủ đạo từ ảnh mẫu.',
          archetype,
          petalShape,
          bloomPrimaryColor,
          bloomSecondaryColor,
          stamenColor: normalizeHex(parsed.stamenColor, '#F2C96B'),
          palette: {
            bgCanvas: normalizeHex(parsed.bgCanvas, '#FFFDF9'),
            bgPaper: normalizeHex(parsed.bgPaper, '#FCF6F2'),
            accentPrimary,
            accentDark: normalizeHex(parsed.accentDark, '#B53559'),
            accentSoft,
            accentBlush: normalizeHex(parsed.accentBlush, '#FDF1F5'),
            foliagePrimary: normalizeHex(parsed.foliagePrimary, '#4E6E49'),
            foliageLight,
            petalColors: [accentPrimary, accentSoft, bloomSecondaryColor, foliageLight],
          },
        },
      });
    } catch (err: unknown) {
      sendAiError(res, err, 'Lỗi không xác định khi phân tích ảnh chủ đề.');
    }
  });

  app.post('/api/ai/discover-card-styles', async (req: Request, res: Response) => {
    try {
      const { cadence = 'weekly', styleKeyword = '', periodLabel = '' } = (req.body ?? {}) as {
        cadence?: 'weekly' | 'monthly';
        styleKeyword?: string;
        periodLabel?: string;
      };

      const ai = getGeminiClient();
      const safeCadence = cadence === 'monthly' ? 'monthly' : 'weekly';
      const resolvedPeriod =
        periodLabel && periodLabel.trim()
          ? periodLabel.trim().slice(0, 80)
          : safeCadence === 'weekly'
          ? 'Đợt AI chọn lọc trong tuần (2 mẫu / tuần)'
          : 'Bộ sưu tập AI chọn lọc trong tháng (2 mẫu / tháng)';

      const searchTopic =
        styleKeyword && styleKeyword.trim()
          ? `theo phong cách "${styleKeyword.trim()}"`
          : 'đa dạng phong cách hiện đại, tối giản vòm Arch, vé Boarding Pass, Editorial hoặc Á Đông';

      const prompt = [
        `Hãy tìm kiếm trực tuyến trên Etsy (etsy.com) và Canva (canva.com) các xu hướng mẫu thiệp cưới online (digital/online wedding invitation templates) nổi bật hiện nay ${searchTopic}.`,
        `Dựa trên các mẫu tìm được từ Etsy và Canva, hãy chọn lọc và lên ý tưởng thiết kế ĐÚNG 2 MẪU thiệp cưới khác biệt nhau (1 mẫu lấy cảm hứng từ Etsy, 1 mẫu lấy cảm hứng từ Canva) cho chu kỳ "${resolvedPeriod}".`,
        'Yêu cầu bắt buộc: Chỉ trả về DUY NHẤT một đối tượng JSON hợp lệ (không thêm văn bản ngoài JSON) theo cấu trúc:',
        '{ "styles": [ { "nameVi": "...", "motifLabelVi": "...", "descriptionVi": "...", "aiAnalysisSummary": "...", "inspirationPlatform": "Etsy", "inspirationUrl": "https://www.etsy.com/...", "cardStyleVariant": "arch-minimal", "archetype": "peony", "petalShape": "round-peony", "bloomPrimaryColor": "#RRGGBB", "bloomSecondaryColor": "#RRGGBB", "stamenColor": "#RRGGBB", "bgCanvas": "#RRGGBB", "bgPaper": "#RRGGBB", "accentPrimary": "#RRGGBB", "accentDark": "#RRGGBB", "accentSoft": "#RRGGBB", "accentBlush": "#RRGGBB", "foliagePrimary": "#RRGGBB", "foliageLight": "#RRGGBB" } ] }',
        'Trong đó cardStyleVariant thuộc ["arch-minimal", "editorial-vellum", "vintage-letterpress", "boarding-pass", "oriental-crimson"], archetype thuộc ["lotus", "peony", "rose", "hydrangea", "lily", "sakura", "orchid", "sunflower", "minimal-leaf"], petalShape thuộc ["pointed-lotus", "round-peony", "rose-petal", "sakura-blossom", "slender-leaf"]. Giữ bgCanvas và bgPaper rất sáng (độ sáng > 93%) để chữ tối dễ đọc.',
      ].join('\n');

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          tools: [{ googleSearch: {} }],
          systemInstruction:
            'Bạn là Giám đốc Sáng tạo Thiệp Cưới Số chuyên nghiên cứu xu hướng trên Etsy và Canva. Luôn thiết kế đúng 2 mẫu thiệp tinh tế mỗi đợt và trả về JSON chuẩn với mã màu HEX 6 ký tự (#RRGGBB).',
        },
      });

      const parsed = extractJsonObject(response.text ?? '{}');
      const rawStyles = Array.isArray(parsed.styles) ? parsed.styles.slice(0, 2) : [];

      const validVariants = new Set([
        'classic',
        'arch-minimal',
        'editorial-vellum',
        'vintage-letterpress',
        'boarding-pass',
        'oriental-crimson',
      ]);
      const validArchetypes = new Set([
        'lotus',
        'peony',
        'rose',
        'hydrangea',
        'lily',
        'sakura',
        'orchid',
        'sunflower',
        'minimal-leaf',
      ]);
      const validPetals = new Set([
        'pointed-lotus',
        'round-peony',
        'rose-petal',
        'sakura-blossom',
        'slender-leaf',
      ]);

      const groundingChunks =
        response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const sources: Array<{ title: string; uri: string }> = [];
      for (const chunk of groundingChunks) {
        const uri = chunk?.web?.uri;
        const title = chunk?.web?.title;
        if (uri && typeof uri === 'string' && !sources.some((s) => s.uri === uri)) {
          sources.push({
            title: typeof title === 'string' && title.trim() ? title.trim() : uri,
            uri,
          });
        }
      }

      const normalizedStyles = rawStyles.map((rawItem, idx) => {
        const item = (rawItem ?? {}) as Record<string, unknown>;
        const platform =
          item.inspirationPlatform === 'Etsy' || item.inspirationPlatform === 'Canva'
            ? item.inspirationPlatform
            : idx === 0
            ? 'Etsy'
            : 'Canva';
        const variant = validVariants.has(String(item.cardStyleVariant))
          ? String(item.cardStyleVariant)
          : idx === 0
          ? 'arch-minimal'
          : 'editorial-vellum';
        const archetype = validArchetypes.has(String(item.archetype))
          ? String(item.archetype)
          : idx === 0
          ? 'peony'
          : 'minimal-leaf';
        const petalShape = validPetals.has(String(item.petalShape))
          ? String(item.petalShape)
          : 'round-peony';
        const accentPrimary = normalizeHex(item.accentPrimary, idx === 0 ? '#8B6343' : '#3F6E54');
        const accentSoft = normalizeHex(item.accentSoft, idx === 0 ? '#D5C0AA' : '#9DC4AD');
        const bloomSecondary = normalizeHex(item.bloomSecondaryColor, '#F6EFE8');
        const foliageLight = normalizeHex(item.foliageLight, '#CFE2C9');

        const rawInspoUrl = typeof item.inspirationUrl === 'string' ? item.inspirationUrl.trim() : '';
        const safeInspoUrl =
          rawInspoUrl.startsWith('https://')
            ? rawInspoUrl
            : platform === 'Etsy'
            ? 'https://www.etsy.com/market/online_wedding_invitation'
            : 'https://www.canva.com/invitations/templates/wedding/';

        return {
          id: `ai-card-${Date.now()}-${idx}`,
          nameVi:
            typeof item.nameVi === 'string' && item.nameVi.trim()
              ? item.nameVi.trim().slice(0, 75)
              : `Mẫu Thiệp ${platform} #${idx + 1}`,
          motifLabelVi:
            typeof item.motifLabelVi === 'string' && item.motifLabelVi.trim()
              ? item.motifLabelVi.trim().slice(0, 32)
              : 'Họa tiết cưới',
          descriptionVi:
            typeof item.descriptionVi === 'string' && item.descriptionVi.trim()
              ? item.descriptionVi.trim()
              : `Mẫu thiệp cưới do AI chọn lọc và lên ý tưởng thiết kế từ xu hướng ${platform}.`,
          aiAnalysisSummary:
            typeof item.aiAnalysisSummary === 'string' && item.aiAnalysisSummary.trim()
              ? item.aiAnalysisSummary.trim()
              : `Thiết kế lấy cảm hứng từ xu hướng mẫu thiệp online trên ${platform}.`,
          archetype,
          petalShape,
          cardStyleVariant: variant,
          inspirationPlatform: platform,
          inspirationUrl: safeInspoUrl,
          batchPeriodLabel: resolvedPeriod,
          cadence: safeCadence,
          isAiGenerated: true,
          bloomPrimaryColor: normalizeHex(item.bloomPrimaryColor, accentPrimary),
          bloomSecondaryColor: bloomSecondary,
          stamenColor: normalizeHex(item.stamenColor, '#E2BE70'),
          palette: {
            bgCanvas: normalizeHex(item.bgCanvas, '#FFFDF9'),
            bgPaper: normalizeHex(item.bgPaper, '#FAF5EE'),
            accentPrimary,
            accentDark: normalizeHex(item.accentDark, '#5E3D28'),
            accentSoft,
            accentBlush: normalizeHex(item.accentBlush, '#FBF3EE'),
            foliagePrimary: normalizeHex(item.foliagePrimary, '#4A6B4E'),
            foliageLight,
            petalColors: [accentPrimary, accentSoft, bloomSecondary, foliageLight],
          },
        };
      });

      if (normalizedStyles.length === 0) {
        throw new Error('AI chưa trả về đủ 2 mẫu thiệp từ Etsy & Canva. Vui lòng thử lại.');
      }

      res.json({
        styles: normalizedStyles,
        sources:
          sources.length > 0
            ? sources.slice(0, 6)
            : [
                {
                  title: 'Etsy — Online Wedding Invitation Ideas',
                  uri: 'https://www.etsy.com/market/online_wedding_invitation',
                },
                {
                  title: 'Canva — Wedding Invitation Templates',
                  uri: 'https://www.canva.com/invitations/templates/wedding/',
                },
              ],
        periodLabel: resolvedPeriod,
      });
    } catch (err: unknown) {
      sendAiError(res, err, 'Lỗi không xác định khi tìm kiếm ý tưởng thiệp trên Etsy & Canva.');
    }
  });

  app.post('/api/ai/discover-envelope-styles', async (req: Request, res: Response) => {
    try {
      const { keyword = '' } = (req.body ?? {}) as { keyword?: string };
      const ai = getGeminiClient();
      const topic = keyword.trim()
        ? `phong cách "${keyword.trim()}"`
        : 'phong cách sang trọng semi-realistic (giấy cotton vân sợi, nhung lụa, lót hoa màu nước botanical liner, dấu sáp 3D)';

      const prompt = [
        `Hãy dùng Google Search tìm kiếm các mẫu bao thư thiệp cưới cao cấp (luxury semi-realistic wedding invitation envelope with wax seal & botanical liner) trên Google theo ${topic}.`,
        'Từ xu hướng thực tế tìm được, hãy lên ý tưởng thiết kế đúng 2 mẫu bao thư semi-realistic khác biệt nhau để mở đầu thiệp cưới online Việt Nam.',
        'Trả về DUY NHẤT một chuỗi JSON hợp lệ (không markdown) theo cấu trúc:',
        '{',
        '  "envelopes": [',
        '    {',
        '      "nameVi": "Tên mẫu bao thư tiếng Việt sang trọng",',
        '      "descriptionVi": "Mô tả ngắn chất liệu giấy, lớp lót hoa và dấu sáp (1-2 câu)",',
        '      "outerPaperColor": "#HEX màu giấy bao thư ngoài",',
        '      "outerPaperTintOverlay": "rgba(r, g, b, 0.34) lớp phủ nhuộm màu lên vân giấy cotton",',
        '      "pocketCreaseColor": "rgba(r, g, b, 0.32) màu bóng nếp gấp",',
        '      "linerBgColor": "#HEX màu nền lớp lót trong",',
        '      "plaqueBgColor": "rgba(255, 253, 249, 0.95)",',
        '      "plaqueBorderColor": "#HEX màu viền nhãn tên cô dâu chú rể",',
        '      "plaqueTextColor": "#HEX màu chữ đậm dễ đọc trên nhãn",',
        '      "waxSealTint": "antique-gold" | "burgundy-red" | "rose-bronze" | "sage-gold",',
        '      "useCrimsonTexture": false',
        '    }',
        '  ]',
        '}',
      ].join('\n');

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          tools: [{ googleSearch: {} }],
        },
      });

      const groundingChunks =
        response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const sources: Array<{ title: string; uri: string }> = [];
      for (const chunk of groundingChunks) {
        const web = (chunk as { web?: { title?: string; uri?: string } }).web;
        if (web?.uri && /^https?:\/\//i.test(web.uri)) {
          sources.push({
            title: (web.title || 'Google Stationery Reference').trim(),
            uri: web.uri,
          });
        }
      }

      const parsed = extractJsonObject(response.text || '');
      const rawEnvelopes = Array.isArray(parsed.envelopes) ? parsed.envelopes.slice(0, 2) : [];
      const validTints = new Set(['antique-gold', 'burgundy-red', 'rose-bronze', 'sage-gold']);

      const envelopes = rawEnvelopes.map((rawItem: unknown, idx: number) => {
        const item = (rawItem ?? {}) as Record<string, unknown>;
        const useCrimson = Boolean(item.useCrimsonTexture);
        const waxSealTint = validTints.has(String(item.waxSealTint))
          ? String(item.waxSealTint)
          : 'antique-gold';

        return {
          id: `ai-google-env-${Date.now()}-${idx + 1}`,
          nameVi:
            typeof item.nameVi === 'string' && item.nameVi.trim()
              ? item.nameVi.trim().slice(0, 75)
              : `Bao Thư Semi-Realistic Google #${idx + 1}`,
          descriptionVi:
            typeof item.descriptionVi === 'string' && item.descriptionVi.trim()
              ? item.descriptionVi.trim()
              : 'Chất liệu giấy mỹ thuật semi-realistic lấy cảm hứng từ xu hướng bao thư cưới trên Google.',
          variant: 'custom-google',
          outerPaperColor: normalizeHex(item.outerPaperColor, '#EDE3D4'),
          outerPaperTintOverlay:
            typeof item.outerPaperTintOverlay === 'string' &&
            item.outerPaperTintOverlay.startsWith('rgba(')
              ? item.outerPaperTintOverlay
              : 'rgba(218, 200, 178, 0.30)',
          pocketCreaseColor:
            typeof item.pocketCreaseColor === 'string' &&
            item.pocketCreaseColor.startsWith('rgba(')
              ? item.pocketCreaseColor
              : 'rgba(92, 74, 54, 0.30)',
          linerBgColor: normalizeHex(item.linerBgColor, '#FAF4EA'),
          plaqueBgColor: 'rgba(255, 253, 248, 0.95)',
          plaqueBorderColor: normalizeHex(item.plaqueBorderColor, '#C4AC84'),
          plaqueTextColor: normalizeHex(item.plaqueTextColor, '#261E18'),
          waxSealTint,
          paperTextureUrl: useCrimson
            ? '/assets/envelope/crimson-brocade.jpg'
            : '/assets/envelope/ivory-cotton.jpg',
          linerTextureUrl: '/assets/envelope/botanical-liner.jpg',
          backdropTextureUrl: '/assets/envelope/desk-backdrop.jpg',
          waxSealTextureUrl: '/assets/envelope/gold-wax-seal.jpg',
          paperBgSize: useCrimson ? '215% 215%' : '158% 158%',
          linerBgSize: '138% 138%',
          googleSourceTitle: sources[idx]?.title || 'Google Wedding Envelope Reference',
          googleSourceUri:
            sources[idx]?.uri ||
            'https://www.google.com/search?tbm=isch&q=luxury+semi+realistic+wedding+envelope+wax+seal',
          isAiCurated: true,
        };
      });

      if (envelopes.length === 0) {
        throw new Error('Chưa nhận được đủ gợi ý mẫu bao thư từ Google Search.');
      }

      res.json({
        envelopes,
        sources: sources.slice(0, 5),
      });
    } catch (err: unknown) {
      sendAiError(res, err, 'Lỗi không xác định khi tìm mẫu bao thư trên Google.');
    }
  });

  app.post('/api/ai/discover-envelope-animations', async (req: Request, res: Response) => {
    try {
      const { keyword = '' } = (req.body ?? {}) as { keyword?: string };
      const ai = getGeminiClient();
      const topic = keyword.trim()
        ? `theo phong cách "${keyword.trim()}"`
        : 'đa dạng từ lật nắp 3D zoom-in điện ảnh, rút thiệp nghiêng editorial đến sương mờ Hàn Quốc';

      const prompt = [
        `Hãy dùng Google Search tìm kiếm xu hướng hoạt ảnh mở bao thư thiệp cưới online (online wedding invitation envelope opening animation trends, wax seal reveal, zoom in transition, fade in card) ${topic}.`,
        'Từ các xu hướng thực tế đó, hãy chọn lọc và thiết kế ĐÚNG 2 kiểu animation mở bao thư kèm thông số chuyển động mượt mà.',
        'Trả về DUY NHẤT một chuỗi JSON hợp lệ (không markdown) theo cấu trúc:',
        '{',
        '  "animations": [',
        '    {',
        '      "nameVi": "Tên hiệu ứng mở bao thư tiếng Việt cuốn hút",',
        '      "descriptionVi": "Mô tả 1-2 câu tiếng Việt về nhịp mở nắp, zoom vào bao thư và thiệp cưới fade-in",',
        '      "trendOrigin": "Nguồn xu hướng (ví dụ: Paperless Post / TikTok Wedding Trend 2026)",',
        '      "variant": "flap-zoom-fade" | "wax-burst-cinematic-zoom" | "ribbon-slide-float-zoom" | "french-gatefold-zoom" | "minimal-veil-zoom",',
        '      "flapDurationMs": 860,',
        '      "cardLiftPercent": 42,',
        '      "cardTiltDeg": -2.0,',
        '      "zoomScale": 1.72,',
        '      "zoomDurationMs": 780,',
        '      "cardFadeInDurationMs": 820',
        '    }',
        '  ]',
        '}',
      ].join('\n');

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          tools: [{ googleSearch: {} }],
        },
      });

      const groundingChunks =
        response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const sources: Array<{ title: string; uri: string }> = [];
      for (const chunk of groundingChunks) {
        const web = (chunk as { web?: { title?: string; uri?: string } }).web;
        if (web?.uri && /^https?:\/\//i.test(web.uri) && !sources.some((s) => s.uri === web.uri)) {
          sources.push({
            title: (web.title || 'Google Animation Trend Reference').trim(),
            uri: web.uri,
          });
        }
      }

      const parsed = extractJsonObject(response.text || '{}');
      const rawAnimations = Array.isArray(parsed.animations) ? parsed.animations.slice(0, 2) : [];
      const validVariants = new Set([
        'flap-zoom-fade',
        'wax-burst-cinematic-zoom',
        'ribbon-slide-float-zoom',
        'french-gatefold-zoom',
        'minimal-veil-zoom',
      ]);

      const clampNum = (val: unknown, min: number, max: number, fallback: number): number => {
        const n = Number(val);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
      };

      const animations = rawAnimations.map((rawItem: unknown, idx: number) => {
        const item = (rawItem ?? {}) as Record<string, unknown>;
        const variant = validVariants.has(String(item.variant))
          ? String(item.variant)
          : idx === 0
          ? 'wax-burst-cinematic-zoom'
          : 'ribbon-slide-float-zoom';

        return {
          id: `ai-trend-anim-${Date.now()}-${idx + 1}`,
          nameVi:
            typeof item.nameVi === 'string' && item.nameVi.trim()
              ? item.nameVi.trim().slice(0, 75)
              : `Hoạt Ảnh Mở Bao Thư Trend #${idx + 1}`,
          descriptionVi:
            typeof item.descriptionVi === 'string' && item.descriptionVi.trim()
              ? item.descriptionVi.trim()
              : 'Bao thư mở nắp 3D, phóng cận cảnh (zoom-in) mượt mà và hiển thị thiệp cưới online bằng hiệu ứng Fade-in.',
          trendOrigin:
            typeof item.trendOrigin === 'string' && item.trendOrigin.trim()
              ? item.trendOrigin.trim().slice(0, 70)
              : sources[idx]?.title || 'Google & Pinterest Wedding Motion Trend',
          variant,
          flapDurationMs: Math.round(clampNum(item.flapDurationMs, 620, 1200, 860)),
          cardLiftPercent: Math.round(clampNum(item.cardLiftPercent, 28, 54, 42)),
          cardTiltDeg: Number(clampNum(item.cardTiltDeg, -5, 5, 0).toFixed(1)),
          zoomScale: Number(clampNum(item.zoomScale, 1.4, 2.05, 1.72).toFixed(2)),
          zoomDurationMs: Math.round(clampNum(item.zoomDurationMs, 580, 1100, 780)),
          cardFadeInDurationMs: Math.round(clampNum(item.cardFadeInDurationMs, 600, 1200, 800)),
          isAiCurated: true,
        };
      });

      if (animations.length === 0) {
        throw new Error('Chưa nhận được gợi ý hoạt ảnh mở bao thư từ AI.');
      }

      res.json({
        animations,
        sources: sources.slice(0, 5),
      });
    } catch (err: unknown) {
      sendAiError(res, err, 'Lỗi không xác định khi chọn lọc hoạt ảnh mở bao thư theo trend.');
    }
  });

  app.post('/api/ai/apply-html-feedback', async (req: Request, res: Response) => {
    try {
      const { feedbackText = '', currentData } = (req.body ?? {}) as {
        feedbackText?: string;
        currentData?: Record<string, unknown>;
      };

      if (!feedbackText || typeof feedbackText !== 'string' || !feedbackText.trim()) {
        res.status(400).json({
          error: 'Vui lòng nhập nội dung feedback / yêu cầu chỉnh sửa thiệp.',
        });
        return;
      }

      const ai = getGeminiClient();
      const prompt = [
        'Người dùng vừa tải file .HTML thiệp cưới lên và gửi yêu cầu chỉnh sửa / feedback sau:',
        `"${feedbackText.trim()}"`,
        '',
        'Dữ liệu thiệp hiện tại (JSON):',
        JSON.stringify(currentData ?? {}, null, 2),
        '',
        'Hãy phân tích chính xác những trường thông tin nào người dùng muốn thay đổi. CHỈ điền giá trị mới cho những trường được yêu cầu thay đổi; những trường KHÔNG được nhắc tới hãy để chuỗi rỗng "" (hoặc 0 với trường số) để hệ thống giữ nguyên.',
      ].join('\n');

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          systemInstruction:
            'Bạn là Chuyên gia Chỉnh sửa Thiệp Cưới Online tiếng Việt. Chỉ thay đổi đúng các mục người dùng yêu cầu trong feedback, giữ nguyên các mục còn lại bằng cách trả về chuỗi rỗng "". Nếu người dùng yêu cầu đổi màu tên cô dâu chú rể, trả về mã HEX #RRGGBB hợp lệ trong coupleNameColor.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summaryVi: {
                type: Type.STRING,
                description: 'Tóm tắt ngắn gọn bằng tiếng Việt các mục vừa cập nhật theo feedback.',
              },
              appliedChanges: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Danh sách từng thay đổi cụ thể đã áp dụng.',
              },
              groomFullName: { type: Type.STRING },
              groomShortName: { type: Type.STRING },
              brideFullName: { type: Type.STRING },
              brideShortName: { type: Type.STRING },
              baoHyTitle: { type: Type.STRING },
              baoHySubtitle: { type: Type.STRING },
              defaultGuestName: { type: Type.STRING },
              envelopeDateFull: { type: Type.STRING },
              venueName: { type: Type.STRING },
              venueHall: { type: Type.STRING },
              venueAddress: { type: Type.STRING },
              receptionTimeText: { type: Type.STRING },
              receptionSolarDateText: { type: Type.STRING },
              receptionScheduleText: { type: Type.STRING },
              blessingMessage: { type: Type.STRING },
              coupleNameColor: {
                type: Type.STRING,
                description: 'Mã màu HEX #RRGGBB nếu người dùng muốn đổi màu chữ tên cô dâu chú rể, ngược lại để rỗng ""',
              },
              waxSealText: {
                type: Type.STRING,
                description: 'Chữ khắc trên dấu mộc sáp (tối đa 12 ký tự) nếu người dùng yêu cầu đổi, ngược lại để rỗng ""',
              },
              coupleNamePosition: {
                type: Type.STRING,
                description:
                  'Một trong: bottom-center, top-flap, above-seal, left-editorial, right-editorial nếu người dùng đổi vị trí tên trên bao thư, ngược lại để rỗng ""',
              },
            },
            required: ['summaryVi', 'appliedChanges'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim()) as Record<string, unknown>;
      const dataPatch: Record<string, unknown> = {};
      const stringFields = [
        'groomFullName',
        'groomShortName',
        'brideFullName',
        'brideShortName',
        'baoHyTitle',
        'baoHySubtitle',
        'defaultGuestName',
        'envelopeDateFull',
        'venueName',
        'venueHall',
        'venueAddress',
        'receptionTimeText',
        'receptionSolarDateText',
        'receptionScheduleText',
        'blessingMessage',
      ] as const;

      for (const key of stringFields) {
        const val = parsed[key];
        if (typeof val === 'string' && val.trim().length > 0) {
          dataPatch[key] = val.trim();
        }
      }

      const rawColor = typeof parsed.coupleNameColor === 'string' ? parsed.coupleNameColor.trim() : '';
      const coupleNameColor = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor.toUpperCase() : undefined;

      const rawSeal = typeof parsed.waxSealText === 'string' ? parsed.waxSealText.trim() : '';
      const waxSealText = rawSeal ? rawSeal.slice(0, 12) : undefined;

      const validPositions = new Set([
        'bottom-center',
        'top-flap',
        'above-seal',
        'left-editorial',
        'right-editorial',
      ]);
      const rawPos =
        typeof parsed.coupleNamePosition === 'string' ? parsed.coupleNamePosition.trim() : '';
      const coupleNamePosition = validPositions.has(rawPos) ? rawPos : undefined;

      const appliedChanges = Array.isArray(parsed.appliedChanges)
        ? parsed.appliedChanges
            .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
            .slice(0, 10)
        : [];

      res.json({
        summaryVi:
          typeof parsed.summaryVi === 'string' && parsed.summaryVi.trim()
            ? parsed.summaryVi.trim()
            : 'Đã cập nhật thiệp cưới theo yêu cầu feedback.',
        appliedChanges,
        dataPatch,
        coupleNameColor,
        waxSealText,
        coupleNamePosition,
      });
    } catch (err: unknown) {
      sendAiError(res, err, 'Lỗi không xác định khi xử lý feedback chỉnh sửa thiệp.');
    }
  });

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Không tìm thấy API này.' });
  });

  if (!IS_PRODUCTION) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    if (!existsSync(path.join(distPath, 'index.html'))) {
      throw new Error('Chưa có thư mục dist. Hãy chạy "npm run build" trước khi "npm start".');
    }
    app.use(express.static(distPath, { maxAge: '1h', index: false }));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Bắt lỗi middleware (JSON sai định dạng, body quá lớn...) và luôn trả JSON thay vì trang HTML lỗi.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const e = err as { type?: string; status?: number; statusCode?: number };
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Dữ liệu gửi lên quá lớn (tối đa 15MB). Hãy chọn ảnh nhỏ hơn.' });
      return;
    }
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Dữ liệu JSON gửi lên không hợp lệ.' });
      return;
    }
    console.error('[Server]', err);
    res.status(e?.status || e?.statusCode || 500).json({ error: 'Lỗi máy chủ nội bộ.' });
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT} (${IS_PRODUCTION ? 'production' : 'development'})`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
