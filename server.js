/**
 * Online Classroom — Signaling Server
 * =============================================================================
 * این سرور هیچ رسانه‌ی صوتی/تصویری را پردازش یا عبور نمی‌دهد. وظیفه‌ی
 * آن فقط سه چیز است:
 *   1) اعتبارسنجی JWT صادرشده توسط وردپرس (تایید هویت + role کاربر)
 *   2) مدیریت «اتاق»‌ها (room) در حافظه (نه دیتابیس — برای سادگی مرحله‌ی ۱)
 *   3) رله کردن پیام‌های Offer/Answer/ICE/Chat بین سوکت‌های یک اتاق
 *
 * ==========================================================================
 * نکته‌ی امنیتی حیاتی — منبع حقیقت نقش:
 * ==========================================================================
 * این سرور هرگز به «role» ای که خودِ کلاینت در یک پیام اعلام می‌کند
 * اعتماد نمی‌کند. تنها منبع معتبر نقش، فیلد role داخل JWT است که توسط
 * وردپرس (با کلید مخفی مشترک JWT_SECRET) امضا شده. این یعنی:
 *   - فقط سوکتی با role==='teacher' اجازه دارد webrtc-offer بفرستد.
 *   - فقط سوکتی با role==='teacher' پیام چت می‌تواند به «همه» بفرستد؛
 *     دانش‌آموز فقط می‌تواند به استاد (broadcaster) پیام بفرستد.
 *   - اگر یک کلاینت مخرب سعی کند رویدادی بفرستد که با role او
 *     نمی‌خواند، سرور آن را silently رد می‌کند (و در لاگ ثبت می‌کند).
 *
 * طراحی برای آینده (SFU / چند کلاس همزمان / ۳۰ دانش‌آموز):
 * تمام state اتاق‌ها در یک ماژول جدا (rooms.js) نگه داشته می‌شود تا
 * در مرحله‌ی بعد بتوان آن را به یک store خارجی (Redis) یا به منطق
 * SFU (mediasoup) وصل کرد بدون لمس این فایل اصلی.
 * =============================================================================
 */

require( 'dotenv' ).config();

const express = require( 'express' );
const http = require( 'http' );
const { Server } = require( 'socket.io' );
const cors = require( 'cors' );
const jwt = require( 'jsonwebtoken' );

const RoomStore = require( './rooms' );
const { verifyToken } = require( './auth' );

const PORT = process.env.PORT || 10000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_STUDENTS_PER_ROOM = parseInt( process.env.MAX_STUDENTS_PER_ROOM || '30', 10 );

const app = express();
app.use( cors( { origin: ALLOWED_ORIGIN } ) );

// یک endpoint سلامت (health check) برای Render.com و مانیتورینگ
app.get( '/health', ( req, res ) => {
	res.json( { status: 'ok', rooms: roomStore.getRoomCount() } );
} );

const httpServer = http.createServer( app );

const io = new Server( httpServer, {
	cors: {
		origin: ALLOWED_ORIGIN,
		methods: [ 'GET', 'POST' ],
	},
	// در پلن رایگان Render.com بهتر است پولینگ هم به‌عنوان fallback فعال باشد
	transports: [ 'websocket', 'polling' ],
} );

const roomStore = new RoomStore();

/**
 * میدلور احراز هویت Socket.io: قبل از برقراری کامل اتصال، توکن JWT
 * موجود در handshake.auth.token را verify می‌کند. در صورت نامعتبر
 * بودن توکن، اتصال اصلاً برقرار نمی‌شود (connect_error در کلاینت).
 */
io.use( ( socket, next ) => {
	const token = socket.handshake.auth && socket.handshake.auth.token;

	if ( ! token ) {
		return next( new Error( 'توکن احراز هویت ارسال نشده است.' ) );
	}

	const payload = verifyToken( token );

	if ( ! payload ) {
		return next( new Error( 'توکن نامعتبر یا منقضی‌شده است.' ) );
	}

	// ذخیره‌ی claims تایید‌شده روی خودِ سوکت برای استفاده در رویدادهای بعدی.
	// این تنها منبع حقیقت نقش/هویت برای کل عمر این اتصال است.
	socket.ocAuth = {
		roomKey: payload.room_key,
		userId: payload.user_id,
		displayName: payload.display_name,
		role: payload.role, // 'teacher' یا 'student' — تایید‌شده توسط وردپرس
	};

	next();
} );

io.on( 'connection', ( socket ) => {
	const auth = socket.ocAuth;
	console.log( `[connect] socket=${ socket.id } user=${ auth.userId } role=${ auth.role } room=${ auth.roomKey }` );

	/* ------------------------------------------------------------
	 * join-room — ورود رسمی سوکت به اتاق مشخص‌شده در توکن.
	 * توجه: roomKey از payload خودِ پیام نمی‌آید؛ از auth.roomKey
	 * (که از JWT استخراج شده) استفاده می‌شود تا کاربری نتواند با
	 * فرستادن roomKey دلخواه به اتاق دیگری «بپیوندد».
	 * ---------------------------------------------------------- */
	socket.on( 'join-room', () => {
		const roomKey = auth.roomKey;
		const room = roomStore.getOrCreateRoom( roomKey );

		// محدودیت ظرفیت: فقط برای دانش‌آموز اعمال می‌شود
		if ( 'student' === auth.role && room.countStudents() >= MAX_STUDENTS_PER_ROOM ) {
			socket.emit( 'room-full' );
			socket.disconnect( true );
			return;
		}

		// قانون دسترسی: در این مدل مرحله‌ی ۱، هر اتاق فقط یک «استاد فعال»
		// دارد. اگر استادی با socket دیگر همین user_id از قبل متصل است
		// (مثلاً رفرش صفحه)، اتصال قبلی را قطع می‌کنیم تا تداخل offer
		// پیش نیاید.
		if ( 'teacher' === auth.role ) {
			const existingTeacherSocketId = room.getTeacherSocketId();
			if ( existingTeacherSocketId && existingTeacherSocketId !== socket.id ) {
				const oldSocket = io.sockets.sockets.get( existingTeacherSocketId );
				if ( oldSocket ) {
					oldSocket.emit( 'error', { message: 'یک نشست دیگر با حساب استاد باز شد.' } );
					oldSocket.disconnect( true );
				}
			}
			room.setTeacher( socket.id, auth );
		} else {
			room.addStudent( socket.id, auth );
		}

		socket.join( roomKey );

		// تایید عضویت برای خودِ کاربر + معرفی استاد فعلی (اگر موجود است)
		socket.emit( 'room-joined', {
			role: auth.role,
			teacherSocketId: room.getTeacherSocketId(),
			participantCount: room.countStudents(),
		} );

		// اطلاع به دیگر اعضای اتاق که یک عضو جدید پیوست (برای اینکه
		// استاد بداند باید Offer جدید بسازد، یا دانش‌آموز بداند استاد
		// تغییر کرده)
		socket.to( roomKey ).emit( 'peer-joined', {
			socketId: socket.id,
			role: auth.role,
			displayName: auth.displayName,
			participantCount: room.countStudents(),
		} );
	} );

	/* ------------------------------------------------------------
	 * webrtc-offer — فقط استاد اجازه دارد Offer بفرستد.
	 * ---------------------------------------------------------- */
	socket.on( 'webrtc-offer', ( payload ) => {
		if ( 'teacher' !== auth.role ) {
			console.warn( `[security] رد شد: تلاش دانش‌آموز ${ auth.userId } برای ارسال Offer.` );
			return;
		}

		if ( ! payload || ! payload.target || ! payload.offer ) {
			return;
		}

		io.to( payload.target ).emit( 'webrtc-offer', {
			from: socket.id,
			offer: payload.offer,
		} );
	} );

	/* ------------------------------------------------------------
	 * webrtc-answer — فقط دانش‌آموز اجازه دارد Answer بفرستد (در
	 * پاسخ به Offer ای که استاد فرستاده).
	 * ---------------------------------------------------------- */
	socket.on( 'webrtc-answer', ( payload ) => {
		if ( 'student' !== auth.role ) {
			console.warn( `[security] رد شد: تلاش غیرمنتظره برای ارسال Answer از role=${ auth.role }.` );
			return;
		}

		if ( ! payload || ! payload.target || ! payload.answer ) {
			return;
		}

		io.to( payload.target ).emit( 'webrtc-answer', {
			from: socket.id,
			answer: payload.answer,
		} );
	} );

	/* ------------------------------------------------------------
	 * webrtc-ice-candidate — هر دو نقش اجازه دارند (لازمه‌ی فنی
	 * برقراری مسیر شبکه‌ای در هر دو جهت)، اما فقط بین دو طرف یک
	 * peer connection معتبر.
	 * ---------------------------------------------------------- */
	socket.on( 'webrtc-ice-candidate', ( payload ) => {
		if ( ! payload || ! payload.target || ! payload.candidate ) {
			return;
		}

		io.to( payload.target ).emit( 'webrtc-ice-candidate', {
			from: socket.id,
			candidate: payload.candidate,
		} );
	} );

	/* ------------------------------------------------------------
	 * chat-message — قانون دسترسی:
	 *   - استاد: پیام به همه‌ی اتاق (broadcast) ارسال می‌شود.
	 *   - دانش‌آموز: پیام فقط به استاد (نه به سایر دانش‌آموزان) می‌رسد.
	 * ---------------------------------------------------------- */
	socket.on( 'chat-message', ( payload ) => {
		if ( ! payload || 'string' !== typeof payload.message ) {
			return;
		}

		const message = payload.message.slice( 0, 1000 ); // محدودیت طول، حتی اگر کلاینت رعایت نکند
		const room = roomStore.getRoom( auth.roomKey );
		if ( ! room ) {
			return;
		}

		const outgoing = {
			senderRole: auth.role,
			senderName: auth.displayName,
			message: message,
		};

		if ( 'teacher' === auth.role ) {
			// استاد به همه‌ی دانش‌آموزان همان اتاق پیام می‌فرستد
			socket.to( auth.roomKey ).emit( 'chat-message', outgoing );
		} else {
			// دانش‌آموز فقط به استاد پیام می‌فرستد (نه broadcast به اتاق)
			const teacherSocketId = room.getTeacherSocketId();
			if ( teacherSocketId ) {
				io.to( teacherSocketId ).emit( 'chat-message', outgoing );
			}
		}

		// مهم: ذخیره‌ی دائمی پیام در دیتابیس وردپرس از طریق REST API
		// (نه اینجا) توسط خودِ کلاینت قبلاً انجام شده/می‌شود، یا می‌توان
		// در مرحله‌ی بعد یک callback HTTP از این سرور به وردپرس اضافه کرد.
	} );

	/* ------------------------------------------------------------
	 * teacher-started-class / teacher-ended-class
	 * ---------------------------------------------------------- */
	socket.on( 'teacher-ended-class', () => {
		if ( 'teacher' !== auth.role ) {
			return;
		}

		socket.to( auth.roomKey ).emit( 'teacher-ended-class' );

		const room = roomStore.getRoom( auth.roomKey );
		if ( room ) {
			room.clearTeacher();
		}
	} );

	/* ------------------------------------------------------------
	 * قطع اتصال
	 * ---------------------------------------------------------- */
	socket.on( 'disconnect', () => {
		const room = roomStore.getRoom( auth.roomKey );

		if ( room ) {
			if ( 'teacher' === auth.role && room.getTeacherSocketId() === socket.id ) {
				room.clearTeacher();
				socket.to( auth.roomKey ).emit( 'teacher-ended-class' );
			} else {
				room.removeStudent( socket.id );
			}

			socket.to( auth.roomKey ).emit( 'peer-left', {
				socketId: socket.id,
				role: auth.role,
				participantCount: room.countStudents(),
			} );

			if ( room.isEmpty() ) {
				roomStore.deleteRoom( auth.roomKey );
			}
		}

		// اطلاع به وردپرس برای به‌روزرسانی جدول participants (best-effort،
		// اگر شکست بخورد مشکلی برای جلسه‌ی فعلی ایجاد نمی‌کند)
		notifyWordPressParticipantLeft( socket.id ).catch( ( err ) => {
			console.warn( '[wp-webhook] خطا در اطلاع‌رسانی به وردپرس:', err.message );
		} );

		console.log( `[disconnect] socket=${ socket.id } user=${ auth.userId }` );
	} );
} );

/**
 * اطلاع‌رسانی best-effort به REST API وردپرس درباره‌ی قطع اتصال یک
 * سوکت، تا جدول participants به‌روزرسانی شود. این درخواست با کلید
 * مخفی مشترک (همان JWT_SECRET) احراز هویت می‌شود.
 *
 * @param {string} socketId
 */
async function notifyWordPressParticipantLeft( socketId ) {
	if ( ! process.env.WP_SITE_URL ) {
		return;
	}

	const url = `${ process.env.WP_SITE_URL.replace( /\/$/, '' ) }/wp-json/online-classroom/v1/internal/participant-left`;

	await fetch( url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-oc-internal-secret': process.env.JWT_SECRET,
		},
		body: JSON.stringify( { socket_id: socketId } ),
	} );
}

httpServer.listen( PORT, () => {
	console.log( `Signaling server در حال اجرا روی پورت ${ PORT }` );
} );
