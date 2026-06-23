/**
 * rooms.js — مدیریت state اتاق‌های کلاس در حافظه‌ی سرور.
 * =============================================================================
 * در مرحله‌ی ۱، تمام state اتاق‌ها (کدام socketId استاد است، کدام
 * socketId ها دانش‌آموز هستند) فقط در حافظه‌ی پروسه‌ی Node.js نگه
 * داشته می‌شود — کافی برای یک سرویس رایگان با یک instance.
 *
 * طراحی برای مرحله‌ی بعد (چند کلاس همزمان روی چند instance، یا
 * نیاز به مقیاس افقی): این فایل تنها نقطه‌ای است که باید عوض شود.
 * رابط (API) این کلاس را عوض نکنید؛ فقط پیاده‌سازی داخلی متدها را
 * به Redis (مثلاً با کتابخانه‌ی ioredis) متصل کنید. بقیه‌ی
 * server.js به این جزئیات کاری ندارد.
 * =============================================================================
 */

/**
 * نمایش‌دهنده‌ی state یک اتاق مشخص.
 */
class Room {
	constructor( roomKey ) {
		this.roomKey = roomKey;

		/** socketId استاد فعلی، یا null اگر استادی متصل نیست */
		this.teacherSocketId = null;

		/** Map<socketId, authInfo> برای دانش‌آموزان متصل */
		this.students = new Map();

		this.createdAt = Date.now();
	}

	setTeacher( socketId, authInfo ) {
		this.teacherSocketId = socketId;
		this.teacherInfo = authInfo;
	}

	clearTeacher() {
		this.teacherSocketId = null;
		this.teacherInfo = null;
	}

	getTeacherSocketId() {
		return this.teacherSocketId;
	}

	addStudent( socketId, authInfo ) {
		this.students.set( socketId, authInfo );
	}

	removeStudent( socketId ) {
		this.students.delete( socketId );
	}

	countStudents() {
		return this.students.size;
	}

	isEmpty() {
		return ! this.teacherSocketId && 0 === this.students.size;
	}
}

/**
 * مخزن سراسری تمام اتاق‌های فعال.
 */
class RoomStore {
	constructor() {
		/** Map<roomKey, Room> */
		this.rooms = new Map();
	}

	getOrCreateRoom( roomKey ) {
		if ( ! this.rooms.has( roomKey ) ) {
			this.rooms.set( roomKey, new Room( roomKey ) );
		}
		return this.rooms.get( roomKey );
	}

	getRoom( roomKey ) {
		return this.rooms.get( roomKey ) || null;
	}

	deleteRoom( roomKey ) {
		this.rooms.delete( roomKey );
	}

	getRoomCount() {
		return this.rooms.size;
	}
}

module.exports = RoomStore;
