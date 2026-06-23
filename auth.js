/**
 * auth.js — اعتبارسنجی JWT صادرشده توسط وردپرس.
 * =============================================================================
 * این ماژول از کتابخانه‌ی استاندارد jsonwebtoken استفاده می‌کند.
 * توکن باید با همان الگوریتم (HS256) و همان کلید مخفی (JWT_SECRET)
 * که در PHP (کلاس OC_JWT) برای امضا استفاده شده، verify شود — یعنی
 * این دو طرف باید دقیقاً یک رشته‌ی JWT_SECRET مشترک داشته باشند.
 * =============================================================================
 */

const jwt = require( 'jsonwebtoken' );

const JWT_SECRET = process.env.JWT_SECRET;

if ( ! JWT_SECRET ) {
	console.warn(
		'[auth] هشدار: متغیر محیطی JWT_SECRET تنظیم نشده است. تمام اتصالات رد خواهند شد.'
	);
}

/**
 * اعتبارسنجی یک JWT و بازگرداندن claims آن در صورت معتبر بودن.
 *
 * @param {string} token
 * @returns {Object|null} payload شامل room_key, user_id, display_name, role — یا null در صورت نامعتبر بودن.
 */
function verifyToken( token ) {
	if ( ! JWT_SECRET ) {
		return null;
	}

	try {
		const payload = jwt.verify( token, JWT_SECRET, { algorithms: [ 'HS256' ] } );

		// بررسی وجود فیلدهای ضروری — اگر هرکدام نباشد، توکن را نامعتبر در نظر می‌گیریم
		if ( ! payload.room_key || ! payload.user_id || ! payload.role ) {
			return null;
		}

		// role باید دقیقاً یکی از دو مقدار مجاز باشد؛ هر مقدار دیگری رد می‌شود
		if ( 'teacher' !== payload.role && 'student' !== payload.role ) {
			return null;
		}

		return payload;
	} catch ( err ) {
		// شامل حالت‌های: امضای نامعتبر، توکن منقضی‌شده، فرمت خراب
		return null;
	}
}

module.exports = { verifyToken };
