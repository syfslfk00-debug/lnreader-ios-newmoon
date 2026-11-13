// One-off injector for Moon v3 i18n keys (en + ar). Idempotent: re-running
// keeps existing values. Mirrors scripts/add-i18n-keys.cjs behaviour.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'i18n', 'languages');

const EN = {
  backupScreen: {
    googleSetupRequired:
      'Google Drive sign-in is unavailable in this build. The app maintainer needs to configure Google sign-in for iOS.',
  },
  translationScreen: {
    autoHeader: 'Automatic translation',
    autoMaster: 'Translate foreign content automatically',
    autoMasterDesc:
      'Detects the content language and starts translating when it differs from the target language — no button press needed.',
    autoScopeMetadata: 'Novel titles and summaries',
    autoScopeMetadataDesc:
      'Search results, source lists and the novel details page.',
    autoScopeReader: 'Chapter content in the reader',
    autoScopeReaderDesc: 'Starts translating a chapter as soon as it opens.',
    autoScopeBrowser: 'Internal browser pages',
    autoScopeBrowserDesc: 'Pages opened through the in-app browser.',
    aiPolicyHeader: 'AI request policy',
    aiMaxRequests: 'Max model requests per chapter',
    aiMaxRequestsDesc:
      'The chapter is sent as one request when possible, then split into large parts. Extra requests beyond this need your approval.',
    aiStreaming: 'Instant translation (streaming)',
    aiStreamingDesc:
      'Show text as it arrives. Supports OpenAI-compatible providers and the official Gemini API.',
    budgetHeader: 'Translation budget',
    budgetRequests: 'AI requests',
    budgetToday: 'today',
    budgetTokens: 'Tokens used',
    budgetTokensHint: 'Shown only when the provider reports them.',
    budgetLimit: 'Daily request limit',
    budgetLimitOff: 'No limit',
    budgetReset: 'Reset counters',
    budgetResetMessage:
      'Reset the request and token counters? Saved translations are not affected.',
    budgetResetDone: 'Counters were reset',
    importFile: 'Import connection data from file',
    importFileTitle: 'Import from file',
    importDetected: 'Detected credential type',
    importExpected: 'Expected provider',
    importMasked: 'Value (masked)',
    importKindToken: 'API token / key',
    importKindCookie: 'Web session cookie',
    importKindUnknown: 'Unrecognized',
    importSaveSecure: 'Save securely',
    importTest: 'Test connection',
    importInvalid: 'No valid credentials were found in this file.',
    importTooLarge: 'This file is too large.',
    importReadError: 'Could not read the file.',
    importSecurityNote:
      'Stored in the iOS Keychain. Never uploaded to any server.',
    importWebWarning:
      'Web-account protocols (ChatGPT/Gemini sessions) are unofficial and may stop working; an official API key is more stable.',
    metadataHeader: 'Novel metadata translation',
    metadataTitleMode: 'Title display',
    titleModeArabic: 'Arabic only',
    titleModeOriginal: 'Original only',
    titleModeBoth: 'Arabic with original below',
    chapterTitles: 'Translate chapter titles',
    chapterTitlesDesc:
      'Adds chapter names in lists to the translation pipeline.',
    showOriginal: 'Show original',
    showTranslation: 'Show translation',
    retranslateSummary: 'Re-translate',
    translatingSummary: 'Translating…',
    originalTitleLabel: 'Original title',
  },
  novelScreen: {
    showOriginalSummary: 'Show original story',
    showTranslatedSummary: 'Show translation',
    retranslateSummary: 'Re-translate summary',
  },
  storage: {
    category: {
      translations: 'Saved translations (titles, summaries, chapters)',
    },
  },
};

const AR = {
  backupScreen: {
    googleSetupRequired:
      'تسجيل الدخول إلى Google Drive غير متاح في هذه النسخة. يحتاج مطوّر التطبيق إلى إعداد تسجيل الدخول لنظام iOS.',
  },
  translationScreen: {
    autoHeader: 'الترجمة التلقائية',
    autoMaster: 'ترجمة المحتوى الأجنبي تلقائيًا',
    autoMasterDesc:
      'يكتشف لغة المحتوى ويبدأ الترجمة تلقائيًا عندما تختلف عن لغة الهدف — دون ضغط زر في كل مرة.',
    autoScopeMetadata: 'أسماء الروايات وملخصاتها',
    autoScopeMetadataDesc: 'نتائج البحث وقوائم المصادر وصفحة تفاصيل الرواية.',
    autoScopeReader: 'محتوى الفصول داخل القارئ',
    autoScopeReaderDesc: 'بدء ترجمة الفصل فور فتحه.',
    autoScopeBrowser: 'صفحات المتصفح الداخلي',
    autoScopeBrowserDesc: 'الصفحات التي تفتح داخل متصفح التطبيق.',
    aiPolicyHeader: 'سياسة طلبات الذكاء الاصطناعي',
    aiMaxRequests: 'أقصى عدد طلبات للنموذج في الفصل',
    aiMaxRequestsDesc:
      'يُرسل الفصل بطلب واحد إن أمكن، وإلا يُقسم إلى أجزاء كبيرة. الطلبات الزائدة عن هذا الحد تحتاج موافقتك.',
    aiStreaming: 'الترجمة اللحظية (بث تدريجي)',
    aiStreamingDesc:
      'اعرض النص أثناء وصوله. يدعم مزودي OpenAI المتوافقين وواجهة Gemini الرسمية.',
    budgetHeader: 'ميزانية الترجمة',
    budgetRequests: 'طلبات الذكاء الاصطناعي',
    budgetToday: 'اليوم',
    budgetTokens: 'الرموز المستهلكة',
    budgetTokensHint: 'تظهر فقط عندما يعيد المزود هذه المعلومة.',
    budgetLimit: 'حد يومي للطلبات',
    budgetLimitOff: 'بدون حد',
    budgetReset: 'تصفير العدادات',
    budgetResetMessage:
      'تصفير عدادات الطلبات والرموز؟ الترجمات المحفوظة لا تتأثر.',
    budgetResetDone: 'تم تصفير العدادات',
    importFile: 'استيراد بيانات الاتصال من ملف',
    importFileTitle: 'استيراد من ملف',
    importDetected: 'نوع بيانات الاتصال المكتشفة',
    importExpected: 'المزود المتوقع',
    importMasked: 'القيمة (مقنّعة)',
    importKindToken: 'رمز / مفتاح API',
    importKindCookie: 'كوكيز جلسة ويب',
    importKindUnknown: 'غير معروف',
    importSaveSecure: 'حفظ بأمان',
    importTest: 'اختبار الاتصال',
    importInvalid: 'لم يُعثر على بيانات صالحة في هذا الملف.',
    importTooLarge: 'هذا الملف كبير جدًا.',
    importReadError: 'تعذر قراءة الملف.',
    importSecurityNote: 'يُحفظ في iOS Keychain ولا يُرفع إلى أي خادم.',
    importWebWarning:
      'بروتوكولات حسابات الويب (ChatGPT/Gemini) غير رسمية وقد تتوقف؛ مفتاح API الرسمي أكثر استقرارًا.',
    metadataHeader: 'ترجمة بيانات الروايات',
    metadataTitleMode: 'عرض العناوين',
    titleModeArabic: 'العربي فقط',
    titleModeOriginal: 'الأصلي فقط',
    titleModeBoth: 'العربي مع الأصلي تحته',
    chapterTitles: 'ترجمة أسماء الفصول',
    chapterTitlesDesc: 'إضافة أسماء الفصول في القوائم إلى مسار الترجمة.',
    showOriginal: 'إظهار الأصل',
    showTranslation: 'إظهار الترجمة',
    retranslateSummary: 'إعادة الترجمة',
    translatingSummary: 'جارٍ الترجمة…',
    originalTitleLabel: 'الاسم الأصلي',
  },
  novelScreen: {
    showOriginalSummary: 'إظهار القصة الأصلية',
    showTranslatedSummary: 'إظهار الترجمة',
    retranslateSummary: 'إعادة ترجمة الملخص',
  },
  storage: {
    category: {
      translations: 'الترجمات المحفوظة (عناوين وملخصات وفصول)',
    },
  },
};

const merge = (locale, patch) => {
  const file = path.join(ROOT, locale, 'strings.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let added = 0;
  for (const [section, keys] of Object.entries(patch)) {
    data[section] = data[section] || {};
    for (const [key, value] of Object.entries(keys)) {
      if (
        data[section][key] === undefined ||
        (section === 'translationScreen' && key === 'aiStreamingDesc')
      ) {
        data[section][key] = value;
        added += 1;
      } else if (locale === 'ar' && data[section][key] === value && false) {
        // keep existing value
      }
    }
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log(locale, 'added', added);
};

merge('en', EN);
merge('ar_SA', AR);
console.log('done');
