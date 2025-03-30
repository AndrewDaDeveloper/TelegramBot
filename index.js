require("dotenv").config();
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");
const { Together } = require("together-ai");

// ⚙️ Configuration & Setup
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TOGETHER_AI_API_KEY = process.env.TOGETHER_AI_API_KEY;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PUBLIC_CHANNEL_ID = Number(process.env.PUBLIC_CHANNEL_ID);
const RESTRICTED_TOPIC_ID = Number(process.env.RESTRICTED_TOPIC_ID);
const PRIVATE_GROUP_ID = process.env.PRIVATE_GROUP_ID;
const PRIVATE_GROUP_INVITE_LINK = process.env.PRIVATE_GROUP_INVITE_LINK || "https://t.me/+zgS8UCh32NUwMTc0";

if (!BOT_TOKEN) {
    console.error("❌ BOT_TOKEN environment variable is missing!");
    process.exit(1);
}

if (!TOGETHER_AI_API_KEY) {
    console.warn("⚠️ TOGETHER_AI_API_KEY environment variable is missing. AI features will be disabled.");
}

if (isNaN(ADMIN_ID)) {
    console.error("❌ ADMIN_ID environment variable is missing or not a number!");
    process.exit(1);
}

if (isNaN(PUBLIC_CHANNEL_ID)) {
    console.error("❌ PUBLIC_CHANNEL_ID environment variable is missing or not a number!");
    process.exit(1);
}

if (isNaN(RESTRICTED_TOPIC_ID)) {
    console.warn("⚠️ RESTRICTED_TOPIC_ID environment variable is missing or not a number. Topic restriction will be disabled.");
}

if (!PRIVATE_GROUP_ID) {
    console.warn("⚠️ PRIVATE_GROUP_ID environment variable is missing. Auto-join to private group will be disabled after verification.");
}

// ✅ Initialize Telegram Bot & Together AI (conditional)
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const together = TOGETHER_AI_API_KEY ? new Together({ apiKey: TOGETHER_AI_API_KEY }) : null;

// 🗂️ Data Storage & Loading
const BOT_DATA_FILE = "data.json";
const VERIFIED_USERS_FILE = "verified_users.json";
const LAST_VERIFICATION_MESSAGE_FILE = "last_verification_message.json";

let botData = loadBotData();
let verifiedUsers = loadVerifiedUsers();
let lastVerificationMessage = loadLastVerificationMessage();

function loadBotData() {
    try {
        const rawData = fs.readFileSync(BOT_DATA_FILE, "utf8");
        return JSON.parse(rawData);
    } catch (error) {
        console.error(`❌ Error loading ${BOT_DATA_FILE}:`, error);
        return { verification_keywords: [], verification_reference: "⚠️ بيانات التوثيق غير متاحة." };
    }
}

function loadVerifiedUsers() {
    try {
        const rawData = fs.readFileSync(VERIFIED_USERS_FILE, "utf8");
        return JSON.parse(rawData);
    } catch (error) {
        console.warn(`⚠️ Warning: Error loading ${VERIFIED_USERS_FILE}. Starting with empty verified users list.`, error);
        return {};
    }
}

function saveVerifiedUsers(users) {
    try {
        fs.writeFileSync(VERIFIED_USERS_FILE, JSON.stringify(users, null, 2));
    } catch (error) {
        console.error(`❌ Error saving to ${VERIFIED_USERS_FILE}:`, error);
    }
}

function loadLastVerificationMessage() {
    try {
        const rawData = fs.readFileSync(LAST_VERIFICATION_MESSAGE_FILE, "utf8");
        return JSON.parse(rawData);
    } catch (error) {
        return { messageId: null };
    }
}

function saveLastVerificationMessage(messageId) {
    try {
        fs.writeFileSync(LAST_VERIFICATION_MESSAGE_FILE, JSON.stringify({ messageId }));
    } catch (error) {
        console.error(`❌ Error saving to ${LAST_VERIFICATION_MESSAGE_FILE}:`, error);
    }
}

// ⏳ Verification Session Management
const verificationSessions = {};
const pendingApprovals = {};

// 🚫 Message Restriction in Specific Topic
bot.on("message", async (msg) => {
    if (!RESTRICTED_TOPIC_ID) return;

    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const topicId = msg.message_thread_id;

    if (topicId === RESTRICTED_TOPIC_ID && userId !== ADMIN_ID) {
        try {
            await bot.deleteMessage(chatId, msg.message_id);
            console.log(`🗑️ Deleted message from user ${userId} in restricted topic.`);
        } catch (error) {
            console.error("❌ Error deleting message in restricted topic:", error);
        }
    }
});

// 💬 Handle User Messages and Verification Answers
bot.on("message", async (msg) => {
    const userId = msg.from.id;
    const userInput = msg.text?.trim();

    if (!userInput) return;

    // ✅ Handle Verification Answer
    if (verificationSessions[userId]) {
        pendingApprovals[userId] = { question: verificationSessions[userId].question, answer: userInput };

        try {
            await bot.sendMessage(
                ADMIN_ID,
                `🔔 **طلب تحقق جديد!**\n👤 المستخدم: ${msg.from.first_name} (ID: ${userId})\n\n📝 **سؤال التحقق:**\n${verificationSessions[userId].question}\n\n✍️ **إجابة المستخدم:**\n${userInput}`,
                {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "✅ قبول", callback_data: `approve_${userId}` }],
                            [{ text: "❌ رفض", callback_data: `reject_${userId}` }]
                        ]
                    }
                }
            );
            await bot.sendMessage(userId, "⏳ تم إرسال إجابتك إلى المسؤول. انتظر الموافقة...");
            delete verificationSessions[userId];
        } catch (error) {
            console.error("❌ Error handling verification answer or sending admin message:", error);
            bot.sendMessage(userId, "❌ Sorry, there was an error processing your answer. Please try again later.");
        }
        return;
    }

    // 🤖 Handle /chat command (if message is not a verification answer)
    if (userInput.startsWith("/chat ")) {
        if (!together) {
            bot.sendMessage(userId, "⚠️ ميزة الدردشة بالذكاء الاصطناعي معطلة بسبب عدم تعيين TOGETHER_AI_API_KEY.");
            return;
        }
        const query = userInput.substring(6).trim();
        if (query) {
            bot.sendMessage(userId, "🤖 جاري التفكير...");
            try {
                // ✅ Use the new general chat AI function
                const responseText = await generateGeneralChatResponse(query);
                bot.sendMessage(userId, responseText);
            } catch (apiError) {
                console.error("❌ خطأ في توليد استجابة الذكاء الاصطناعي:", apiError);
                bot.sendMessage(userId, "⚠️ خدمة الذكاء الاصطناعي غير متوفرة حاليًا. يرجى المحاولة لاحقًا.");
            }
        } else {
            bot.sendMessage(userId, "➡️ الاستخدام: `/chat [سؤالك]`");
        }
    }
});


// 📢 Admin Command: /sendverify - Send or Update Verification Message
bot.onText(/\/sendverify/, async (msg) => {
    const userId = msg.from.id;

    if (userId !== ADMIN_ID) {
        bot.sendMessage(userId, "❌ هذا الأمر مخصص فقط للمسؤول.");
        return;
    }

    const verificationText = "📢 هل ترغب في التقدم للتحقق؟ اضغط على الزر أدناه لبدء العملية.";
    const verificationKeyboard = {
        reply_markup: {
            inline_keyboard: [[{ text: "📝 التقدم للتحقق", callback_data: "start_verification" }]]
        }
    };

    try {
        if (lastVerificationMessage.messageId) {
            await bot.editMessageText(verificationText, {
                chat_id: PUBLIC_CHANNEL_ID,
                message_id: lastVerificationMessage.messageId,
                ...verificationKeyboard
            });
            console.log(`✅ تم تحديث رسالة التحقق في القناة ${PUBLIC_CHANNEL_ID}`);
            bot.sendMessage(userId, "✅ تم تحديث رسالة التحقق بنجاح!");
        } else {
            const message = await bot.sendMessage(PUBLIC_CHANNEL_ID, verificationText, verificationKeyboard);
            lastVerificationMessage.messageId = message.message_id;
            saveLastVerificationMessage(message.message_id);
            console.log(`✅ تم إرسال رسالة تحقق جديدة إلى القناة ${PUBLIC_CHANNEL_ID}`);
            bot.sendMessage(userId, "✅ تم إرسال رسالة التحقق بنجاح!");
        }
    } catch (error) {
        console.error("❌ خطأ في إرسال أو تحديث رسالة التحقق:", error);
        bot.sendMessage(userId, "❌ فشل إرسال/تحديث رسالة التحقق. تحقق من السجلات.");
    }
});

// 🖱️ Handle Callback Queries (Button Clicks)
bot.on("callback_query", async (query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === "start_verification") {
        if (verifiedUsers[userId]) {
            bot.sendMessage(userId, "✅ أنت بالفعل مستخدم موثق.");
            return;
        }

        // ✅ Arabic Verification Question
        const verificationQuestion = "ما هو الغرض من التحقق في هذا المجتمع؟";
        verificationSessions[userId] = { question: verificationQuestion };

        try {
            await bot.sendMessage(userId, `📝 **سؤال التحقق:**\n${verificationQuestion}\n\n💡 **أرسل إجابتك الآن.**`, { parse_mode: "Markdown" });
        } catch (error) {
            console.error("❌ خطأ في إرسال سؤال التحقق إلى المستخدم:", error);
            bot.sendMessage(userId, "❌ فشل بدء عملية التحقق. يرجى المحاولة لاحقًا.");
        }
    } else if (data.startsWith("approve_") || data.startsWith("reject_")) {
        if (userId !== ADMIN_ID) {
            bot.answerCallbackQuery(query.id, { text: "❌ إجراءات المسؤول فقط!" });
            return;
        }

        const [action, targetUserId] = data.split("_");
        const targetUserIdNum = Number(targetUserId);

        if (!pendingApprovals[targetUserIdNum]) {
            bot.answerCallbackQuery(query.id, { text: "⚠️ طلب الموافقة منتهي الصلاحية أو غير موجود." });
            return;
        }

        if (action === "approve") {
            verifiedUsers[targetUserIdNum] = true;
            saveVerifiedUsers(verifiedUsers);
            try {
                await bot.sendMessage(targetUserIdNum, "🎉 تهانينا! تم توثيق حسابك بنجاح.");

                // ✅ Auto-join to Private Group on Approval
                if (PRIVATE_GROUP_ID) {
                    try {
                        await bot.telegram.addChatMember(PRIVATE_GROUP_ID, targetUserIdNum);
                        console.log(`✅ User ${targetUserIdNum} added to private group ${PRIVATE_GROUP_ID}`);
                        await bot.sendMessage(targetUserIdNum, `🎉 تم أيضًا إضافتك إلى المجموعة الخاصة بالمستخدمين الموثوقين!`);
                    } catch (joinError) {
                        console.error(`❌ Error adding user ${targetUserIdNum} to private group ${PRIVATE_GROUP_ID}:`, joinError);
                        await bot.sendMessage(targetUserIdNum, `⚠️ حدث خطأ أثناء إضافتك تلقائيًا إلى المجموعة الخاصة. يرجى الانضمام باستخدام هذا الرابط: ${PRIVATE_GROUP_INVITE_LINK}`);
                        await bot.sendMessage(ADMIN_ID, `⚠️ فشل إضافة المستخدم ${targetUserIdNum} إلى المجموعة الخاصة تلقائيًا. تم إرسال رابط الدعوة إلى المستخدم.`);
                    }
                }

                bot.answerCallbackQuery(query.id, { text: "✅ تم توثيق المستخدم!" });
            } catch (error) {
                console.error("❌ خطأ في إرسال رسالة التوثيق الناجح إلى المستخدم:", error);
                bot.answerCallbackQuery(query.id, { text: "✅ تم التوثيق (خطأ في إرسال الرسالة) - تحقق من السجلات!" });
            }

        } else if (action === "reject") {
            try {
                await bot.sendMessage(targetUserIdNum, "❌ تم رفض طلب التوثيق الخاص بك.");
                bot.answerCallbackQuery(query.id, { text: "❌ تم رفض المستخدم" });
            } catch (error) {
                console.error("❌ خطأ في إرسال رسالة الرفض إلى المستخدم:", error);
                bot.answerCallbackQuery(query.id, { text: "❌ تم الرفض (خطأ في إرسال الرسالة) - تحقق من السجلات!" });
            }
        }
        delete pendingApprovals[targetUserIdNum];
    }
    bot.answerCallbackQuery(query.id);
});


// 🧠 Generate AI Response for Verification (using Together AI) - FOR VERIFICATION ANSWERS
async function generateVerificationResponse(userInput) {
    if (!together) {
        return "⚠️ خدمة الذكاء الاصطناعي غير مهيأة.";
    }
    try {
        const response = await together.chat.completions.create({
            model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
            messages: [
                {
                    role: "system",
                    content: `أنت مساعد ذكاء اصطناعي متخصص في الإجابة على أسئلة متعلقة بالتوثيق لتقييم إجابات المستخدمين.
                              بدلاً من نسخ المعلومات المرجعية مباشرة، قم بفهمها وإعادة صياغتها بطرق مختلفة،
                              مع الحفاظ على الجوهر والمعنى الأساسي. اجعل كل إجابة تبدو فريدة ومفهومة. ركز على الوضوح والإيجاز.`,
                },
                { role: "user", content: `📌 **مرجع التوثيق:**\n${botData.verification_reference}\n\n
                              📝 افهم هذا المرجع جيدًا، ثم أعد صياغته بطريقة جديدة للإجابة على السؤال التالي:` },
                { role: "user", content: `❓ السؤال: ${userInput}` },
            ],
        });

        return response.choices?.[0]?.message?.content.trim() || "❌ لم أتمكن من توليد استجابة.";
    } catch (error) {
        console.error("❌ خطأ في واجهة برمجة تطبيقات Together:", error);
        return "⚠️ خدمة الذكاء الاصطناعي غير متوفرة حاليًا، يرجى المحاولة لاحقًا.";
    }
}

// 🧠 Generate AI Response for General Chat (using Together AI) - NEW FUNCTION FOR GENERAL CHAT
async function generateGeneralChatResponse(userInput) {
    if (!together) {
        return "⚠️ خدمة الذكاء الاصطناعي غير مهيأة.";
    }
    try {
        const response = await together.chat.completions.create({
            model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
            messages: [
                {
                    role: "system",
                    content: `أنت مساعد ذكاء اصطناعي ودود ومتعاون يجيب على أسئلة المستخدمين بشكل عام. يمكنك التحدث عن أي موضوع تقريبًا.
                              إذا سألك المستخدم عن "التحقق" أو "التوثيق" في هذا المجتمع، اشرح لهم بإيجاز عملية التحقق:
                              "للتحقق في هذا المجتمع، يجب عليك النقر على زر 'التقدم للتحقق' الموجود في الرسالة المثبتة في القناة العامة. سيُطلب منك الإجابة على سؤال بسيط يتعلق بالغرض من التوثيق في المجتمع. بعد إرسال إجابتك، سيراجعها المسؤول. إذا تمت الموافقة عليها، فسيتم توثيق حسابك وستتم إضافتك إلى المجموعة الخاصة بالمستخدمين الموثوقين."
                              كن ودودًا ومفيدًا قدر الإمكان في جميع إجاباتك.`,
                },
                { role: "user", content: `❓ سؤال المستخدم: ${userInput}` },
            ],
        });

        return response.choices?.[0]?.message?.content.trim() || "❌ لم أتمكن من توليد استجابة.";
    } catch (error) {
        console.error("❌ خطأ في واجهة برمجة تطبيقات Together عند الدردشة العامة:", error);
        return "⚠️ خدمة الذكاء الاصطناعي غير متوفرة حاليًا، يرجى المحاولة لاحقًا.";
    }
}


// 🚀 Bot Startup Message
console.log("🤖 بوت التيليجرام متصل ويعمل!");

// 🚨 Error Handling for Bot Polling
bot.on("polling_error", (error) => {
    console.error("🚨 خطأ في استطلاع بوت التيليجرام:", error);
});

bot.on("error", (error) => {
    console.error("🚨 خطأ عام في بوت التيليجرام:", error);
});
