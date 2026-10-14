const mongoose = require('mongoose');
const { Schema } = mongoose;

// Користувачі. Галочка isAdmin ставиться прямо в базі (Compass / Atlas)
// або командою `npm run make-admin "Прізвище Ім'я По батькові"`.
const userSchema = new Schema({
  fullName: { type: String, required: true },
  nameKey: { type: String, required: true, unique: true },
  isAdmin: { type: Boolean, default: false },
  // Пристрій, за яким закріплено ПІБ. Очистіть поле (null), щоб людина могла зайти з нового телефону.
  deviceId: { type: String, default: null },
  lastLoginAt: Date,
}, { timestamps: true });

// Пари розкладу (спільні для всіх)
const lessonSchema = new Schema({
  lid: { type: String, required: true, unique: true },   // «yyyyMMdd-номер пари»
  pair: Number,
  start: { type: Date, index: true },
  end: Date,
  subjectKey: String,
  kind: String,
  topic: String,
  room: String,
  teacher: String,
  isRemote: Boolean,
}, { versionKey: false });

// Предмети: коротка назва з розкладу → повна назва + посилання на онлайн-пару
const subjectSchema = new Schema({
  key: { type: String, required: true, unique: true },
  fullName: { type: String, default: '' },
  link: { type: String, default: '' },
}, { versionKey: false });

// Викладачі: запис з розкладу («Іванов І.І.») → повне ПІБ
const teacherSchema = new Schema({
  key: { type: String, required: true, unique: true },
  fullName: { type: String, default: '' },
}, { versionKey: false });

const homeworkSchema = new Schema({
  subjectKey: { type: String, required: true },
  lessonId: { type: String, default: null },
  text: { type: String, required: true },
  due: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  author: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  authorName: { type: String, default: '' },
  reviewedBy: String,
  reviewedAt: Date,
}, { timestamps: true });

const settingSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: Schema.Types.Mixed,
}, { versionKey: false });

module.exports = {
  User: mongoose.model('User', userSchema),
  Lesson: mongoose.model('Lesson', lessonSchema),
  Subject: mongoose.model('Subject', subjectSchema),
  Teacher: mongoose.model('Teacher', teacherSchema),
  Homework: mongoose.model('Homework', homeworkSchema),
  Setting: mongoose.model('Setting', settingSchema),
};
