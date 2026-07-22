require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(express.json());

// ─── جدار الحماية (Rate Limiter) لمنع التخمين العشوائي ───
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 دقيقة
    max: 20, // 20 محاولة كحد أقصى لكل IP
    message: { valid: false, reason: "rate_limit", detail: "محاولات كثيرة جداً، يرجى المحاولة بعد 15 دقيقة." }
});

// ─── الاتصال بقاعدة بيانات MongoDB ───
// يمكنك تغيير الرابط لاحقاً برابط MongoDB Atlas الخاص بك
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/lovable_pro';
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Database'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ─── هيكلة قاعدة البيانات (Schemas) ───

// 1. جدول التراخيص المدفوعة
const licenseSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    plan: { type: String, required: true }, // Daily, Weekly, Monthly, Yearly
    durationDays: { type: Number, required: true },
    status: { type: String, default: 'unused' }, // unused, active, expired
    boundDevice: { type: Object, default: null }, // البصمة الصلبة المربوطة
    started_at: { type: Date, default: null },
    expires_at: { type: Date, default: null },
    usage_count: { type: Number, default: 0 }, // العداد التراكمي
    daily_limit: { type: Number, default: 500 } // سياسة الاستخدام العادل
});
const License = mongoose.model('License', licenseSchema);

// 2. جدول الفترات التجريبية (يحذف البيانات تلقائياً بعد 30 يوم)
const trialSchema = new mongoose.Schema({
    device_hash: { type: String, required: true, unique: true },
    components: { type: Object, required: true },
    usage_count: { type: Number, default: 0 },
    started_at: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now, expires: '30d' } // ميزة الـ TTL للتنظيف التلقائي
});
const Trial = mongoose.model('Trial', trialSchema);


const crypto = require('crypto'); // أضف هذا في أعلى الملف مع الاستدعاءات

// ─── مسارات لوحة التحكم (Admin APIs) ───
// يمكنك تغيير هذه الكلمة المرورية في بيئة الإنتاج عبر ملف .env
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'VibeAdmin2026'; 

// وسيط حماية (Middleware) للتأكد من صلاحيات المدير
const adminAuth = (req, res, next) => {
    const auth = req.headers['x-admin-auth'];
    if (auth === ADMIN_PASSWORD) next();
    else res.status(401).json({ error: 'غير مصرح لك بالدخول' });
};

// أ. توليد أكواد اشتراك جديدة
app.post('/api/admin/generate', adminAuth, async (req, res) => {
    try {
        const { plan, durationDays, count } = req.body;
        const keys = [];
        for (let i = 0; i < (count || 1); i++) {
            // توليد كود عشوائي آمن
            const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
            const key = `LEP-${plan.toUpperCase()}-${randomPart}`;
            
            const newLicense = new License({ key, plan, durationDays });
            await newLicense.save();
            keys.push(key);
        }
        res.json({ success: true, keys });
    } catch (err) {
        res.status(500).json({ error: "حدث خطأ في توليد الأكواد" });
    }
});

// ب. جلب إحصائيات النظام والتراخيص
app.get('/api/admin/stats', adminAuth, async (req, res) => {
    try {
        const licenses = await License.find().sort({ _id: -1 });
        const trials = await Trial.find().sort({ started_at: -1 });
        
        // حساب إجمالي عمليات التخطي التي وفرتها الأداة
        const totalLicenseUsage = licenses.reduce((sum, l) => sum + (l.usage_count || 0), 0);
        const totalTrialUsage = trials.reduce((sum, t) => sum + (t.usage_count || 0), 0);
        
        res.json({ 
            success: true, 
            total_injections: totalLicenseUsage + totalTrialUsage,
            licenses, 
            trials_count: trials.length 
        });
    } catch (err) {
        res.status(500).json({ error: "حدث خطأ في جلب الإحصائيات" });
    }
});

// ج. حذف أو حظر جهاز من كود معين (لفك الارتباط)
app.post('/api/admin/reset-device', adminAuth, async (req, res) => {
    try {
        const { key } = req.body;
        const lic = await License.findOne({ key });
        if (lic) {
            lic.boundDevice = null;
            lic.status = 'unused'; // إعادته لحالة غير مستخدم ليتمكن من تفعيله على جهاز جديد
            await lic.save();
            res.json({ success: true, message: "تم فك ارتباط الجهاز بنجاح" });
        } else {
            res.status(404).json({ error: "الكود غير موجود" });
        }
    } catch (err) {
        res.status(500).json({ error: "حدث خطأ" });
    }
});

// ─── خوارزمية التطابق المرن (Fuzzy Matching Logic) ───
function calculateDeviceScore(incomingComps, storedComps) {
    if (!incomingComps || !storedComps) return 0;
    let score = 0;
    if (incomingComps.webgl === storedComps.webgl) score += 35;
    if (incomingComps.audio === storedComps.audio) score += 35;
    if (incomingComps.hw === storedComps.hw) score += 10;
    if (incomingComps.fonts === storedComps.fonts) score += 10;
    if (incomingComps.screen === storedComps.screen) score += 10;
    return score;
}

// ─── الروابط (APIs) ───

// 1. فحص وتحديث حالة الاشتراك المدفوع
app.post('/api/public/license/validate', limiter, async (req, res) => {
    try {
        const { license_key, device_hash, components, usage_count } = req.body;
        const key = String(license_key || "").trim().toUpperCase();
        const incomingCount = Number(usage_count) || 0;

        // البحث عن الكود في قاعدة البيانات
        const lic = await License.findOne({ key: key });

        if (lic) {
            // تحديث العداد بأعلى رقم (Anti-Cheat)
            lic.usage_count = Math.max(lic.usage_count, incomingCount);

            // تفعيل الكود إذا كان غير مستخدم
            if (lic.status === 'unused') {
                lic.status = 'active';
                lic.started_at = new Date();
                const expiry = new Date();
                expiry.setDate(expiry.getDate() + lic.durationDays);
                lic.expires_at = expiry;
                lic.boundDevice = components;
            } else if (lic.status === 'active') {
                // التأكد من أن الكود لم ينتهِ
                if (new Date() > lic.expires_at) {
                    lic.status = 'expired';
                    await lic.save();
                    return res.json({ valid: false, reason: "expired", detail: "انتهى اشتراكك." });
                }

                // فحص البصمة لمنع مشاركة الكود (يجب أن يكون التطابق 75% أو أكثر)
                const score = calculateDeviceScore(components, lic.boundDevice);
                if (score < 75) {
                    return res.json({ valid: false, reason: "device_limit_reached", detail: "هذا الترخيص مربوط بجهاز آخر." });
                }

                // تحديث البصمة لتظل مرنة
                lic.boundDevice = components;
            } else if (lic.status === 'expired') {
                return res.json({ valid: false, reason: "expired", detail: "انتهى اشتراكك." });
            }

            await lic.save(); // حفظ التحديثات في قاعدة البيانات

            return res.json({
                valid: true,
                plan: lic.plan,
                started_at: lic.started_at.toISOString(),
                expires_at: lic.expires_at.toISOString()
            });
        }

        // Fallback للتجربة المجانية
        const trial = await Trial.findOne({ device_hash: device_hash });
        if (trial) {
            trial.usage_count = Math.max(trial.usage_count, incomingCount);
            await trial.save();

            if ((Date.now() - trial.started_at.getTime()) < 1800000) { // 30 دقيقة
                return res.json({
                    valid: true, 
                    plan: "تجربة مجانية (30 دقيقة)",
                    started_at: trial.started_at.toISOString(),
                    expires_at: new Date(trial.started_at.getTime() + 1800000).toISOString()
                });
            }
        }

        res.json({ valid: false, reason: "not_found" });

    } catch (error) {
        console.error(error);
        res.json({ valid: false, reason: "server_error" });
    }
});

// 2. تفعيل الفترة التجريبية الجديدة
app.post('/api/public/trial/auto-license', limiter, async (req, res) => {
    try {
        const { device_hash, components, usage_count } = req.body;
        if (!device_hash) return res.json({ ok: false, reason: "missing_device" });

        const incomingCount = Number(usage_count) || 0;

        // فحص البصمة المرنة لمنع التحايل عبر المتصفحات
        const allTrials = await Trial.find();
        for (const storedTrial of allTrials) {
            const score = calculateDeviceScore(components, storedTrial.components);
            if (score >= 75) {
                // الجهاز موجود بالفعل
                storedTrial.usage_count = Math.max(storedTrial.usage_count, incomingCount);
                await storedTrial.save();

                const remaining = 1800000 - (Date.now() - storedTrial.started_at.getTime());
                if (remaining <= 0) {
                    return res.json({ ok: false, detail: "لقد استهلكت الفترة التجريبية لهذا الجهاز مسبقاً." });
                }

                return res.json({
                    ok: true,
                    license_key: `LEP-TRIAL-${storedTrial.device_hash.slice(0,8)}`,
                    plan: "تجربة مجانية (30 دقيقة)",
                    started_at: storedTrial.started_at.toISOString(),
                    expires_at: new Date(storedTrial.started_at.getTime() + 1800000).toISOString()
                });
            }
        }

        // إنشاء تجربة جديدة
        const newTrial = new Trial({
            device_hash: device_hash,
            components: components,
            usage_count: incomingCount,
            started_at: new Date()
        });
        await newTrial.save();

        res.json({
            ok: true,
            license_key: `LEP-TRIAL-${device_hash.slice(0,8)}`,
            plan: "تجربة مجانية (30 دقيقة)",
            started_at: newTrial.started_at.toISOString(),
            expires_at: new Date(newTrial.started_at.getTime() + 1800000).toISOString()
        });

    } catch (error) {
        console.error(error);
        res.json({ ok: false, reason: "server_error" });
    }
});

app.get('/api/public/extension/version', (req, res) => {
    res.json({ version: "1.0.0", mandatory: false, download_url: "#" });
});

// ─── دوال بناء هيكل التخطي (Fix Error) ───
function generateTypeID(prefix) {
    const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
    let suffix = "01";
    for (let i = 0; i < 24; i++) { suffix += alphabet[Math.floor(Math.random() * alphabet.length)]; }
    return `${prefix}_${suffix}`;
}

function buildFixErrorFields(prompt) {
    const buildEventId = `main:agent#01${Date.now()}#bld:${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    return {
        id: generateTypeID("umsg"),
        ai_message_id: generateTypeID("aimsg"),
        message: `For the code present, I get the error below.\n\nPlease think step-by-step in order to resolve it.\n\`\`\`\n${prompt}\n\`\`\`\n`,
        intent: "fix_error",
        contains_error: true,
        error_ids: [buildEventId],
        error_source: "build_errors",
        message_intent_metadata: {
            fix_error_metadata: { errors: [{ error_type: "build", error_message: prompt, build_event_id: buildEventId }] }
        }
    };
}

app.post('/api/public/license/transform', (req, res) => {
    res.json({ ok: true, fields: buildFixErrorFields(req.body.prompt || "") });
});

app.post('/api/public/license/deactivate', (req, res) => {
    res.json({ ok: true });
});

// تشغيل السيرفر محلياً فقط إذا لم نكن في بيئة Vercel
if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => {
        console.log('🚀 VibeCoding Server running on http://localhost:3000');
    });
}

// تصدير التطبيق ليعمل على Vercel Serverless
module.exports = app;