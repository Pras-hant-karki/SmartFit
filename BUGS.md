# SmartFit — Bug Report & Fix Guide

**Project:** SmartFit Hospital Management System  
**Stack:** Node.js / Express / MongoDB (Backend) · React / Redux Toolkit (Frontend)  
**Base URL:** `http://localhost:8000/api/v1`  
**Total Bugs:** 20 main + 7 informational  

---

## Severity Definitions

| Severity | Criteria | Examples |
|---|---|---|
| **Critical** | Entire feature broken for all users. Authentication or session management fails completely with no workaround. | Token renewal permanently broken for every patient, doctor, and admin |
| **High** | Actively exploitable by any authenticated user. Exposes other users' private data, enables account takeover, or allows irreversible harm with minimal effort. | IDOR exposing medical records; OTP brute force → full account takeover |
| **Medium** | Real impact but requires specific conditions or has partial reach. Wrong status codes leaking internals, logic errors reachable under normal use, weak cryptographic controls. | 500 leaking JWT error details; Math.random() OTP; in-memory OTP storage |
| **Low** | Incorrect behaviour or broken API contract. No direct exploitability on its own, but can combine with other issues or causes wrong results. | Past-date bookings; optional confirmPassword; raw unpopulated response |
| **Informational** | Code quality, typos, missing best-practice controls. No exploitability on their own, but are worth fixing before production. | Missing security headers; field name typo; emoji in log statement |

---

## ⭐ Most Prominent Bug

> **BUG-003 — IDOR: Any Authenticated Patient Can Read Any Other Patient's Full Appointment Record**

Any logged-in patient can retrieve the complete medical appointment record of any other patient in the system — name, email, phone number, age, sex, symptoms, and medical history — by guessing or incrementing a MongoDB ObjectId. Requires only a valid account and one API call. Full details in BUG-003 below.

---

## Main Bugs (20)

---

## 🔴 CRITICAL

---

### BUG-001 · Refresh Token JWT Missing `role` Claim — All Three User Models

**Files:**
- `Backend/src/models/patient.model.js` · Line 86 — `generaterefreshtoken()`
- `Backend/src/models/doctor.model.js` · Line 85 — `generaterefreshtoken()`
- `Backend/src/models/admin.model.js` · Line 59 — `generaterefreshtoken()`

**Severity:** Critical  
**Category:** Broken Authentication (OWASP A07:2021)

**Description:**  
All three `generaterefreshtoken()` methods sign a JWT containing only `{ _id }`. The renewal controllers for each role check `decoded.role !== "<role>"` — since `decoded.role` is always `undefined`, this condition is permanently `true`. Token renewal fails with HTTP 401 for **every** user of every role. This is the direct cause of the `"Patient session required"` error visible in the server logs.

The exact same bug exists in all three models. Only the role string differs.

**Buggy Code (identical pattern in all three models):**
```js
// patient.model.js:86  |  doctor.model.js:85  |  admin.model.js:59
patientSchema.methods.generaterefreshtoken = function () {
    return jwt.sign(
        { _id: this._id },          // ← role is missing
        process.env.REFRESH_TOKEN_SECRET,
        { expiresIn: process.env.REFRESH_TOKEN_EXPIRY }
    )
}
```

**Steps to Reproduce (patient — same flow applies to doctor and admin):**
```bash
# 1. Login
curl -c cookies.txt -s -X POST http://localhost:8000/api/v1/patient/login \
  -H "Content-Type: application/json" \
  -d '{"email":"patient@test.com","password":"password123"}'

# 2. Call the renewal endpoint
curl -b cookies.txt -X POST http://localhost:8000/api/v1/patient/renew-access-token
# Expected: 200 { accesstoken: "..." }
# Actual:   401 { message: "Patient session required" }
#           (decoded.role is undefined, check decoded.role !== "patient" is always true)
```

**Fix — add `role` to the payload in all three models:**
```js
// patient.model.js
patientSchema.methods.generaterefreshtoken = function () {
    return jwt.sign({ _id: this._id, role: "patient" }, ...);
};
// doctor.model.js
doctorSchema.methods.generaterefreshtoken = function () {
    return jwt.sign({ _id: this._id, role: "doctor" }, ...);
};
// admin.model.js
adminSchema.methods.generaterefreshtoken = function () {
    return jwt.sign({ _id: this._id, role: "admin" }, ...);
};
```

---

### BUG-002 · `refreshtoken` Field Excluded from DB Lookup During Renewal — All Three Controllers

**Files:**
- `Backend/src/controllers/patient.controller.js` · Line 213
- `Backend/src/controllers/doctor.controller.js` · Line 475
- `Backend/src/controllers/admin.controller.js` · Line 184

**Severity:** Critical  
**Category:** Broken Authentication

**Description:**  
The Patient, Doctor, and Admin schemas define `refreshtoken: { ..., select: false }`. This tells Mongoose to exclude the field from query results by default. Each renewal controller calls `findById()` **without** `.select("+refreshtoken")`, so the field is always `undefined`. The comparison `user.refreshtoken !== incomingToken` resolves to `undefined !== "<valid-token>"` — always `true` — and immediately throws "Refresh token mismatch or expired". Even after BUG-001 is fixed, this bug alone keeps renewal broken for all three roles.

**Buggy Code (same pattern in all three controllers):**
```js
// patient.controller.js:213
const patient = await Patient.findById(decoded._id);
// patient.refreshtoken is always undefined because select:false
if (patient.refreshtoken !== refreshToken) {     // undefined !== token → always true
    throw new apiError(401, "Refresh token mismatch or expired");
}
```

**Fix — add `.select("+refreshtoken")` in all three renewal functions:**
```js
// patient.controller.js
const patient = await Patient.findById(decoded._id).select("+refreshtoken");

// doctor.controller.js
const doctor = await Doctor.findById(decodetoken._id).select("+refreshtoken");

// admin.controller.js
const admin = await Admin.findById(decodetoken._id).select("+refreshtoken");
```

---

## 🟠 HIGH

---

### BUG-003 · IDOR — Any Authenticated Patient Can Read Any Other Patient's Appointment ⭐ MOST PROMINENT

**File:** `Backend/src/controllers/appointment.controller.js` · Line 276  
**Route:** `GET /api/v1/patient/appointments/:appointmentid`  
**Severity:** High  
**Category:** Insecure Direct Object Reference — OWASP A01:2021 Broken Access Control

**Description:**  
`getappointment` fetches the appointment and populates both patient and doctor with sensitive fields (name, email, age, sex, phone number, symptoms, medical history). There is **no check** that the requesting patient owns the appointment. Any authenticated patient can pass any MongoDB ObjectId and retrieve a complete medical record belonging to a stranger.

**Buggy Code:**
```js
// appointment.controller.js:276
const getappointment = asyncHandler(async (req, res) => {
    const { appointmentid } = req.params;
    const appointment = await Appointment.findById(appointmentid)
        .populate("patient", "patientname patientusername age sex phonenumber email")
        .populate("doctor", "doctorname doctorusername department ...");
    if (!appointment) throw new apiError(404, "Not found");
    // ← no ownership check whatsoever
    return res.status(200).json(new apiResponse(200, formatAppointment(appointment)));
});
```

**Steps to Reproduce:**
```bash
# Register Patient A, book an appointment, note the _id in the response
curl -c patient_a.txt -X POST http://localhost:8000/api/v1/patient/login \
  -H "Content-Type: application/json" \
  -d '{"email":"patient_a@test.com","password":"pass1234"}'

curl -c patient_a.txt -X POST \
  "http://localhost:8000/api/v1/patient/appointments/book-appointment/<DOCTOR_ID>" \
  -H "Content-Type: application/json" \
  -d '{"appointmentdate":"2026-08-01","appointmenttime":"10:00","symptoms":"Headache"}'
# Note the appointment _id from the response → <APPOINTMENT_ID>

# Register Patient B (completely different account)
curl -c patient_b.txt -X POST http://localhost:8000/api/v1/patient/login \
  -H "Content-Type: application/json" \
  -d '{"email":"patient_b@test.com","password":"pass1234"}'

# As Patient B, read Patient A's appointment
curl -b patient_b.txt \
  "http://localhost:8000/api/v1/patient/appointments/<APPOINTMENT_ID>"
# Expected: 403 Forbidden
# Actual:   200 — full record including Patient A's name, email, age, sex, phone, symptoms
```

**Fix:**
```js
const getappointment = asyncHandler(async (req, res) => {
    const { appointmentid } = req.params;
    const appointment = await Appointment.findById(appointmentid)
        .populate("patient", "patientname patientusername age sex phonenumber email")
        .populate("doctor", "doctorname doctorusername department ...");
    if (!appointment) throw new apiError(404, "Not found");

    // Enforce ownership
    if (req.patient &&
        appointment.patient._id.toString() !== req.patient._id.toString()) {
        throw new apiError(403, "Access denied");
    }

    return res.status(200).json(new apiResponse(200, formatAppointment(appointment)));
});
```

---

### BUG-004 · No Rate Limiting on OTP Endpoints — Email Spam and OTP Brute Force

**File:** `Backend/src/app.js` · Lines 90–93  
**Routes:** `POST /patient/forgot-password/send-otp`, `POST /patient/forgot-password/verify-otp`  
**Severity:** High  
**Category:** Missing Security Control — OWASP A05:2021

**Description:**  
`authLimiter` is applied only to the login routes for patient, doctor, and admin. The forgot-password OTP endpoints have **no rate limiting**. This allows two attacks:

1. **Email bombing** — repeatedly calling `send-otp` floods a victim's inbox
2. **OTP brute force** — a 6-digit numeric OTP has only 1,000,000 combinations; with no request cap, brute-forcing the `verify-otp` endpoint is practical within hours

**Steps to Reproduce (email spam):**
```bash
for i in $(seq 1 50); do
  curl -s -X POST http://localhost:8000/api/v1/patient/forgot-password/send-otp \
    -H "Content-Type: application/json" \
    -d '{"email":"victim@email.com"}'
done
# All 50 requests succeed — 50 OTP emails sent to victim, no 429 returned
```

**Steps to Reproduce (OTP brute force):**
```bash
curl -c cookies.txt -X POST http://localhost:8000/api/v1/patient/forgot-password/send-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"your_account@test.com"}'

for i in $(seq -w 000000 999999); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b cookies.txt \
    -X POST http://localhost:8000/api/v1/patient/forgot-password/verify-otp \
    -H "Content-Type: application/json" \
    -d "{\"otp\":\"$i\"}")
  if [ "$STATUS" = "200" ]; then echo "OTP FOUND: $i"; break; fi
done
```

**Fix:**
```js
// app.js — add a dedicated OTP rate limiter
const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { statusCode: 429, message: "Too many OTP requests. Try again later." },
});

app.use("/api/v1/patient/forgot-password/send-otp", otpLimiter);
app.use("/api/v1/patient/forgot-password/verify-otp", otpLimiter);
app.use("/api/v1/doctor/forgot-password/send-otp", otpLimiter);
app.use("/api/v1/doctor/forgot-password/verify-otp", otpLimiter);
```

---

### BUG-005 · Password-Reset JWT (TempToken) Exposed in JSON Response Body

**File:** `Backend/src/controllers/otp.controller.js` · Line 100  
**Severity:** High  
**Category:** Sensitive Data Exposure — OWASP A02:2021

**Description:**  
The tempToken is a JWT that grants permission to reset a user's password. It is correctly placed in an HttpOnly cookie but is **also returned raw in the JSON response body**. Frontend JavaScript can read `response.data.data` and extract the full token. Combined with an XSS vulnerability, an attacker could steal the tempToken and silently reset any user's password without their knowledge.

**Buggy Code:**
```js
return res.status(200)
    .cookie("tempToken", tempToken, options)
    .json(new apiResponse(200, tempToken, "OTP sent successfully"));
//                        ↑ raw JWT returned in body — readable by any JS on the page
```

**Steps to Reproduce:**
```bash
curl -v -X POST http://localhost:8000/api/v1/patient/forgot-password/send-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"patient@test.com"}'

# Response body:
# { "statusCode":200, "data":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...", "message":"OTP sent..." }
# The raw password-reset JWT is fully readable by frontend JS
```

**Fix:**
```js
return res.status(200)
    .cookie("tempToken", tempToken, options)
    .json(new apiResponse(200, {}, "OTP sent successfully"));
//                        ↑ empty body — token only in HttpOnly cookie
```

---

### BUG-006 · Cron Job Silently Fails to Send Cancellation Emails — Wrong Field Reference

**File:** `Backend/src/controllers/cron.controller.js` · Lines 40–55  
**Severity:** High  
**Category:** Silent Data Loss / Logic Error

**Description:**  
The `Appointment` schema stores patient and doctor as ObjectId references. There is no `patientdetails` or `doctordetails` field on the model. The cron controller accesses `appointment.patientdetails.patientusername` (line 41) and `appointment.doctordetails.doctorname` (line 52), both of which are `undefined`. This throws a `TypeError` that is swallowed by the surrounding `try/catch`. Result: appointments are cancelled in the database correctly, but **no cancellation emails are ever sent**.

There is also a secondary issue on the same call: even if `patientdetails` existed, `Patient.findOne({ patientname: appointment.patientdetails.patientusername })` queries the wrong field (`patientname` vs `patientusername`).

**Buggy Code:**
```js
// cron.controller.js:40
const patient = await Patient.findOne({
    patientname: appointment.patientdetails.patientusername,  // TypeError: Cannot read 'patientusername' of undefined
}).select("email patientname");
// ...
html: appointmentcancellation(
    patient.patientname,
    appointment.doctordetails.doctorname,   // TypeError: Cannot read 'doctorname' of undefined
    ...
),
```

**Steps to Reproduce:**
```bash
# 1. Create a confirmed appointment and set its date to the past in MongoDB
# 2. Trigger the cron endpoint
curl -H "x-cron-secret: <CRON_SECRET>" http://localhost:8000/api/v1/auto-cancel

# 3. Check DB — appointment status is "Cancelled" ✓
# 4. Check inbox — no email received ✗
# 5. Check server logs — TypeError: Cannot read properties of undefined (reading 'patientusername')
```

**Fix — populate the appointment before the loop:**
```js
const expiredAppointments = await Appointment.find({
    status: "Confirmed",
    appointmentdate: { $lt: today },
}).populate("patient", "email patientname").populate("doctor", "doctorname");

for (const appointment of expiredAppointments) {
    const patient = appointment.patient;
    if (!patient?.email) continue;
    sendMail({
        to: patient.email,
        html: appointmentcancellation(
            patient.patientname,
            appointment.doctor.doctorname,   // populated doctor
            appointment.appointmentdate,
            appointment.appointmenttime
        ),
    });
}
```

---

## 🟡 MEDIUM

---

### BUG-007 · `jwt.verify()` Throws Exceptions but Code Checks `if (!decoded)` — Dead Code Causes 500 on Bad Tokens

**Files:**
- `Backend/src/controllers/patient.controller.js` · Line 205
- `Backend/src/controllers/doctor.controller.js` · Line 468
- `Backend/src/controllers/admin.controller.js` · Line 177

**Severity:** Medium  
**Category:** Improper Error Handling / Information Disclosure — OWASP A09:2021

**Description:**  
`jwt.verify()` **never returns `null`**. It either returns the decoded payload or throws a typed exception (`JsonWebTokenError`, `TokenExpiredError`, `NotBeforeError`). The `if (!decoded)` block after each call is unreachable dead code. When a token is expired or tampered, the exception propagates to the global error middleware, which returns HTTP 500 (instead of 401) and includes the raw JWT library error message (`"jwt expired"`, `"invalid signature"`) in the response body. The same dead code pattern and 500 behaviour exist in all three renewal controllers.

**Buggy Code (same pattern in all three controllers):**
```js
// patient.controller.js:205  |  doctor.controller.js:468  |  admin.controller.js:177
const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
if (!decoded) {    // ← unreachable: jwt.verify throws, never returns null/undefined
    throw new apiError(401, "Invalid refresh token");
}
```

**Steps to Reproduce:**
```bash
curl -X POST http://localhost:8000/api/v1/patient/renew-access-token \
  -H "Cookie: refreshToken=eyJhbGciOiJIUzI1NiJ9.tampered.signature"
# Expected: 401 { message: "Invalid refresh token" }
# Actual:   500 { message: "invalid signature" }  ← JWT library internals leaked
```

**Fix — wrap in try/catch in all three controllers:**
```js
let decoded;
try {
    decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
} catch {
    throw new apiError(401, "Invalid or expired refresh token");
}
```

---

### BUG-008 · `req.cookies || req.body` Logic Error — Body Fallback Never Executes

**Files:**
- `Backend/src/controllers/doctor.controller.js` · Line 463
- `Backend/src/controllers/admin.controller.js` · Line 172

**Severity:** Medium  
**Category:** Logic Error

**Description:**  
`req.cookies` is set by `cookie-parser` to an **empty object `{}`** when no cookies are present. An empty object is truthy. Therefore `req.cookies || req.body` always evaluates to `req.cookies`, and the `req.body` fallback is **never reached**. If a client sends the refresh token in the request body (mobile clients, server-side callers), it is silently ignored and the endpoint returns 401. This bug exists in both the doctor and admin renewal functions.

**Buggy Code (same pattern in both controllers):**
```js
// doctor.controller.js:463  |  admin.controller.js:172
const { refreshtoken } = req.cookies || req.body;
// req.cookies is always {} (truthy), so req.body is NEVER read
// refreshtoken = undefined when no cookie is set
```

**Steps to Reproduce:**
```bash
# Send refresh token in body only (no cookie)
curl -X POST http://localhost:8000/api/v1/doctor/renew-access-token \
  -H "Content-Type: application/json" \
  -d '{"refreshtoken":"<valid_doctor_refresh_token>"}'
# Expected: 200 with new access token
# Actual:   401 "Unauthorized request" — body token is never read
```

**Fix:**
```js
const refreshtoken = req.cookies?.refreshtoken || req.body?.refreshtoken;
```

---

### BUG-009 · No Status Validation on Appointment Mutation Endpoints — `cancelappointment` and `updateappointment`

**File:** `Backend/src/controllers/appointment.controller.js`  
- `cancelappointment` · Line 192  
- `updateappointment` · Line 230

**Severity:** Medium  
**Category:** Logic Error / Missing State Validation

**Description:**  
Neither `cancelappointment` nor `updateappointment` checks the appointment's current `status` before proceeding. Two concrete problems:

- **`updateappointment`**: A `Cancelled` or `Completed` appointment can be rescheduled — effectively re-opening a closed record
- **`cancelappointment`**: A `Completed` appointment can be cancelled, altering historical medical records; an already-`Cancelled` appointment can be cancelled again, resetting the `deleteafter` timer

Both mutation endpoints share the same missing guard.

**Buggy Code:**
```js
// cancelappointment (line 192) — no status check
appointment.status = "Cancelled";   // runs even if already Cancelled or Completed
appointment.deleteafter = new Date(Date.now() + 24 * 60 * 60 * 1000);  // timer reset
await appointment.save();

// updateappointment (line 230) — no status check
if (req.patient && appointment.patient.toString() !== req.patient._id.toString()) {
    throw new apiError(403, "Not allowed");
}
// ← proceeds to update a Cancelled or Completed appointment
```

**Steps to Reproduce (re-cancelling a Cancelled appointment):**
```bash
# 1. Cancel an appointment
curl -b cookies.txt -X POST \
  "http://localhost:8000/api/v1/patient/appointments/cancelAppointment/<ID>"

# 2. Cancel again — succeeds with 200
curl -b cookies.txt -X POST \
  "http://localhost:8000/api/v1/patient/appointments/cancelAppointment/<ID>"
# Expected: 400 "Appointment is already cancelled"
# Actual:   200 — deleteafter timer reset

# Steps to Reproduce (update a Cancelled appointment):
curl -b cookies.txt -X PATCH \
  "http://localhost:8000/api/v1/patient/appointments/updateappointment/<ID>" \
  -H "Content-Type: application/json" \
  -d '{"appointmentdate":"2027-01-01","appointmenttime":"09:00"}'
# Expected: 400 "Cannot update a cancelled appointment"
# Actual:   200 — appointment rescheduled to 2027
```

**Fix:**
```js
// Add at the top of both handlers after the findById lookup
if (appointment.status === "Cancelled") {
    throw new apiError(400, "Cannot modify a cancelled appointment");
}
if (appointment.status === "Completed") {
    throw new apiError(400, "Cannot modify a completed appointment");
}
```

---

### BUG-010 · OTP Generation Uses `Math.random()` — Not Cryptographically Secure

**File:** `Backend/src/utils/otpgenerator.js` · Line 3  
**Severity:** Medium  
**Category:** Weak Cryptography — OWASP A02:2021

**Description:**  
`Math.random()` is a pseudorandom number generator (PRNG) seeded by the V8 engine. Its output is not cryptographically unpredictable. OTPs used for password resets must be generated from a CSPRNG to prevent prediction attacks. Node.js provides `crypto.randomInt()` for this purpose.

**Buggy Code:**
```js
otp += digits[Math.floor(Math.random() * digits.length)];
```

**Fix:**
```js
import crypto from "crypto";
const generateOtp = (length = 6) =>
    crypto.randomInt(0, 10 ** length).toString().padStart(length, "0");
export default generateOtp;
```

---

### BUG-011 · OTPs Stored as Plaintext in an In-Memory Map — Cleared on Every Server Restart

**File:** `Backend/src/services/otp.js` · Lines 1–10  
**Severity:** Medium  
**Category:** Insecure Storage / Reliability

**Description:**  
Two distinct problems:  
1. OTPs are stored as **plaintext** in a process-level `Map`. A memory dump, process inspector, or accidental log would expose every active OTP.  
2. The Map lives in the Node.js process. On any server restart, crash, or deployment, all pending OTPs are lost. A user who requested an OTP before the restart cannot complete their password reset.

**Buggy Code:**
```js
const otpMap = new Map();
export const saveOTP = (email, otp) => { otpMap.set(email, otp); ... }
// otp is the raw 6-digit string, readable by anyone with process access
```

**Steps to Reproduce (OTP loss):**
1. `POST /patient/forgot-password/send-otp` — OTP saved
2. Restart the Node.js process (`pm2 restart` / `Ctrl+C && node server.js`)
3. `POST /patient/forgot-password/verify-otp` with the correct OTP
4. **Actual:** `404 "OTP not found or expired"` — Map was cleared on restart

**Fix:**
```js
import bcrypt from "bcrypt";
import redis from "./redisClient.js";

export const saveOTP = async (email, otp, ttl = 120) => {
    const hash = await bcrypt.hash(otp, 10);
    await redis.setEx(`otp:${email}`, ttl, hash);
};
export const verifyOTP = async (email, otp) => {
    const hash = await redis.get(`otp:${email}`);
    return hash ? bcrypt.compare(otp, hash) : false;
};
```

---

### BUG-012 · Phone Number Field Typed as `Number` — Leading Zeros Silently Dropped

**File:** `Backend/src/models/patient.model.js` · Line 22  
**Severity:** Medium  
**Category:** Data Integrity / Input Validation

**Description:**  
`phonenumber: { type: Number }` causes Mongoose to coerce the value to a JavaScript number before saving. Phone numbers like `"0123456789"` become `123456789` (leading zero lost). International format numbers like `"+9779812345678"` produce `NaN`, which may be silently stored as `0` or fail schema validation. The doctor model correctly uses `type: String`, making this an inconsistency as well as a data-integrity bug.

**Steps to Reproduce:**
```bash
curl -X POST http://localhost:8000/api/v1/patient/register \
  -H "Content-Type: application/json" \
  -d '{"patientname":"Test","patientusername":"t1","email":"t@t.com",
       "password":"Pass1234","phonenumber":"0123456789","age":25,"sex":"Male"}'

curl -b cookies.txt http://localhost:8000/api/v1/patient/get-profile
# phonenumber in response: 123456789  ← leading zero permanently lost
```

**Fix:**
```js
phonenumber: {
    type: String,   // ← String, not Number
    required: true,
    trim: true,
    match: [/^\+?[0-9]{7,15}$/, "Invalid phone number format"],
},
```

---

### BUG-013 · Global Redux `isPending/isRejected` Matchers Contaminate All Slice State

**Files:**
- `Frontend/src/store/slices/authSlice.js` · Line 66
- `Frontend/src/store/slices/patientSlice.js` · Line 91
- `Frontend/src/store/slices/appointmentSlice.js` · Line 53
- `Frontend/src/store/slices/prescriptionSlice.js` · Line 34
- `Frontend/src/store/slices/labtestSlice.js` · Line 34

**Severity:** Medium  
**Category:** Frontend Logic Error / State Corruption

**Description:**  
All five Redux slices use `isPending`, `isFulfilled`, and `isRejected` from `@reduxjs/toolkit` without any action-type filter. These matchers match **every async action dispatched to the entire Redux store**, not just the owning slice's own thunks.

Concrete consequences:
- When `getAllPrescriptions` fails with 403, `auth.error` is overwritten with a prescription error
- When any appointment thunk starts, `labtest.loading`, `prescription.loading`, `auth.loading`, and `patient.loading` all flip to `true` simultaneously
- Clicking "Book Appointment" may briefly show a login spinner

The same buggy pattern exists identically in all five slices.

**Buggy Code (identical pattern in all 5 slices):**
```js
// authSlice.js:66 (and equivalent lines in the other 4 slices)
builder.addMatcher(isPending, (state) => { state.loading = true; });
// ↑ matches EVERY async action across the entire store, not just auth actions
builder.addMatcher(isRejected, (state, action) => { state.error = action.payload; });
// ↑ overwrites this slice's error with any other slice's error
```

**Fix — scope matchers to the slice's own thunks in each slice:**
```js
// authSlice.js — use isAnyOf scoped to auth thunks only
import { isAnyOf } from "@reduxjs/toolkit";
const authThunks = [registerPatient, loginPatient, logoutPatient, getCurrentPatient];

builder.addMatcher(isAnyOf(...authThunks.map(t => t.pending)), (state) => {
    state.loading = true; state.error = null;
});
builder.addMatcher(isAnyOf(...authThunks.map(t => t.rejected)), (state, action) => {
    state.loading = false; state.error = action.payload;
});
// Repeat with each slice's own thunk array
```

---

### BUG-014 · URL Substring Role Detection in `verifyAuth` — Any JWT Authenticates to Unmatched Routes

**File:** `Backend/src/middlewares/auth.middleware.js` · Lines 17–29  
**Severity:** Medium  
**Category:** Broken Access Control — OWASP A01:2021

**Description:**  
`verifyAuth` infers the expected role from the URL using `req.originalUrl.includes(...)`:

```
"/admin"       → role must be "admin"
"/doctor"      → role must be "doctor"
"/patient" or "/appointment" → role must be "patient"
otherwise      → desiredRole = null
```

When `desiredRole` is `null`, the guard condition is:
```js
if (!desiredRole || payload.role === desiredRole) { decoded = payload; }
```

`!null` is `true`, so the first branch fires — any valid JWT of any role is accepted. If a current or future route URL does not contain any of the four keyword substrings, every user role can authenticate to it regardless of intended access control.

Additionally, substring matching is fragile: a URL like `/api/v1/doctor-statistics` would match `/doctor` and require a doctor token, but `/api/v1/admin-public-info` would require admin — even if those roles were wrong for those routes.

**Buggy Code:**
```js
// auth.middleware.js:17
const desiredRole = req.originalUrl.includes("/admin")
    ? "admin"
    : req.originalUrl.includes("/doctor")
      ? "doctor"
      : req.originalUrl.includes("/patient") || req.originalUrl.includes("/appointment")
        ? "patient"
        : null;   // ← any valid JWT authenticates when route matches none of the above
```

**Fix — pass the required role explicitly via middleware parameter:**
```js
// auth.middleware.js
const verifyAuth = (requiredRole) => asyncHandler(async (req, res, next) => {
    // ... verify JWT ...
    if (requiredRole && payload.role !== requiredRole) {
        throw new apiError(403, `${requiredRole} access required`);
    }
    // ... lookup user ...
});

// Routes use it explicitly:
router.post("/login", verifyAuth("patient"), loginPatient);
router.get("/profile", verifyAuth("doctor"), getDoctorProfile);
```

---

## 🟢 LOW

---

### BUG-015 · CORS `!origin` Bypass — Requests with No Origin Header Skip the Allowlist

**File:** `Backend/src/app.js` · Line 36  
**Severity:** Low  
**Category:** Misconfiguration — OWASP A05:2021

**Description:**  
The CORS configuration returns `callback(null, true)` when `origin` is `null` or `undefined`. This means any request that omits the `Origin` header — server-to-server calls, `curl`, Postman, or pages served via `file://` — bypasses the allowlist entirely. In `production`, where the `allowedOrigins` list is the only intended gate, this means non-browser clients are unconditionally accepted.

**Buggy Code:**
```js
// app.js:36
if (!origin) return callback(null, true);   // ← allowlist bypassed when no Origin header
```

**Steps to Reproduce:**
```bash
# No Origin header — bypasses the allowlist
curl -X GET http://localhost:8000/api/v1/patient/get-all-doctors
# Returns data even though no Origin is in allowedOrigins

# With an unlisted origin — correctly blocked
curl -H "Origin: https://evil.example.com" http://localhost:8000/api/v1/patient/get-all-doctors
# Returns CORS error
```

**Fix:**
```js
origin: function (origin, callback) {
    // Only allow explicitly listed origins; block requests with no origin in production
    if (!origin) {
        if (!isProduction) return callback(null, true);   // allow in dev only
        return callback(new Error("Direct server-to-server requests are not allowed"));
    }
    if (allowedOrigins.includes(origin) || isLocalDevOrigin(origin)) {
        return callback(null, true);
    }
    callback(new Error(`Not allowed by CORS: ${origin}`));
},
```

---

### BUG-016 · Appointment Booking Allows Past Dates — No Future-Date Validation

**File:** `Backend/src/controllers/appointment.controller.js` · Line 68  
**Severity:** Low  
**Category:** Input Validation

**Description:**  
`createAppointment` converts `appointmentdate` to a `Date` object and saves it with no check that it falls in the future. A patient can book an appointment dated yesterday, last year, or any past date, creating meaningless records and polluting history.

**Buggy Code:**
```js
// appointment.controller.js:69
const created = await Appointment.create({
    ...
    appointmentdate: new Date(appointmentdate),   // no future-date check
    ...
});
```

**Steps to Reproduce:**
```bash
curl -b cookies.txt -X POST \
  "http://localhost:8000/api/v1/patient/appointments/book-appointment/<DOCTOR_ID>" \
  -H "Content-Type: application/json" \
  -d '{"appointmentdate":"2020-01-01","appointmenttime":"10:00","symptoms":"Test"}'
# Expected: 400 "Appointment date must be in the future"
# Actual:   201 — appointment created with date in 2020
```

**Fix:**
```js
const appointmentDateObj = new Date(appointmentdate);
if (appointmentDateObj <= new Date()) {
    throw new apiError(400, "Appointment date must be in the future");
}
```

---

### BUG-017 · HTTP 201 Returned by `registerPatient` but `apiResponse` Body Says `statusCode: 200`

**File:** `Backend/src/controllers/patient.controller.js` · Line 109  
**Severity:** Low  
**Category:** API Contract Inconsistency

**Description:**  
The HTTP response line says `201 Created`, but the JSON body contains `"statusCode": 200`. Any client that checks `response.data.statusCode` to determine success/failure sees conflicting information. Every other registration endpoint in the app uses matching values.

**Buggy Code:**
```js
return res.status(201).json(
    new apiResponse(200, createdpatient, "patient registered Successfully")
//               ↑ 200 in body, 201 on the wire — conflicting
)
```

**Steps to Reproduce:**
```bash
curl -i -X POST http://localhost:8000/api/v1/patient/register ...
# HTTP/1.1 201   ← HTTP status
# { "statusCode": 200 }  ← body status
```

**Fix:**
```js
return res.status(201).json(
    new apiResponse(201, createdpatient, "Patient registered successfully")
)
```

---

### BUG-018 · `confirmPassword` Validation Is Optional — Server-Side Bypass Possible

**File:** `Backend/src/controllers/patient.controller.js` · Line 56  
**Severity:** Low  
**Category:** Input Validation Weakness

**Description:**  
The password-match check is wrapped in `if (confirmPassword && ...)`. Omitting `confirmPassword` from the request body entirely causes the condition to short-circuit to `false`, bypassing all password confirmation logic. An API client (curl, mobile app, Postman) can register without ever sending the field.

**Buggy Code:**
```js
if (confirmPassword && confirmPassword !== password) {
//  ↑ if confirmPassword is undefined, this is false → no check runs
    throw new apiError(400, "Passwords do not match")
}
```

**Steps to Reproduce:**
```bash
curl -X POST http://localhost:8000/api/v1/patient/register \
  -H "Content-Type: application/json" \
  -d '{"patientname":"Bob","patientusername":"bob1","email":"bob@test.com",
       "password":"mypassword","phonenumber":"9876543210","age":30,"sex":"Male"}'
# Note: confirmPassword field is absent
# Expected: 400 "confirmPassword is required"
# Actual:   201 — registration succeeds
```

**Fix:**
```js
if (!confirmPassword) throw new apiError(400, "Confirm password is required");
if (confirmPassword !== password) throw new apiError(400, "Passwords do not match");
```

---

### BUG-019 · Appointment Booking Has No Doctor Shift Validation — Any Time Slot Accepted

**File:** `Backend/src/controllers/appointment.controller.js` · Line 56  
**Severity:** Low  
**Category:** Business Logic Bypass

**Description:**  
`checkavailability` computes valid time slots from the doctor's `shift` array and filters out past dates. However, `createAppointment` does **not** validate the requested `appointmenttime` against the doctor's shift schedule before saving. A patient can book at 3:00 AM on a day the doctor does not work, and the appointment will be confirmed. The availability check is advisory only — it has no enforcement.

**Steps to Reproduce:**
```bash
# Book a slot outside the doctor's working hours
curl -b cookies.txt -X POST \
  "http://localhost:8000/api/v1/patient/appointments/book-appointment/<DOCTOR_ID>" \
  -H "Content-Type: application/json" \
  -d '{"appointmentdate":"2026-08-01","appointmenttime":"03:00","symptoms":"Test"}'
# Expected: 400 "Doctor is not available at this time"
# Actual:   201 — appointment confirmed for 3:00 AM
```

**Fix:**
```js
// In createAppointment, validate slot against shift before saving
const requestedDay = new Date(appointmentdate)
    .toLocaleDateString("en-US", { weekday: "long" });
const validSlots = computeSlotsForDay(doctor.shift, requestedDay);
if (!validSlots.includes(appointmenttime)) {
    throw new apiError(400, "Doctor is not available at the requested time");
}
```

---

### BUG-020 · `updateappointment` Returns Raw Unpopulated Mongoose Document

**File:** `Backend/src/controllers/appointment.controller.js` · Line 272  
**Severity:** Low  
**Category:** API Inconsistency

**Description:**  
After saving the appointment, `updateappointment` returns the raw Mongoose document directly. All other appointment endpoints use `formatAppointment(appointment)` on a populated document. The raw document contains `__v`, and `patient` and `doctor` fields are bare ObjectId strings (not populated objects). A frontend consuming this inconsistent response would show `undefined` for `doctordetails.doctorname` and `patientdetails.patientname` immediately after an update.

**Buggy Code:**
```js
// appointment.controller.js:272
return res.status(200).json(new apiResponse(200, appointment));
//                                           ↑ raw doc, not formatAppointment(populatedDoc)
```

**Fix:**
```js
const updatedAppointment = await Appointment.findById(appointment._id)
    .populate("patient", "patientname patientusername age sex phonenumber email")
    .populate("doctor", "doctorname doctorusername department specialization qualification consultationfee");

return res.status(200).json(new apiResponse(200, formatAppointment(updatedAppointment)));
```

---

## ℹ️ INFORMATIONAL

---

### INFO-001 · Typo in Error Message: "Patient not dound"

**File:** `Backend/src/controllers/patient.controller.js` · Line 360  
```js
throw new apiError(404, "Patient not dound")   // ← "dound" should be "found"
```
**Fix:** `throw new apiError(404, "Patient not found")`

---

### INFO-002 · Persistent Field Name Typo: `diagonosis` Instead of `diagnosis`

**Files:** `Backend/src/models/prescription.model.js`, `Backend/src/controllers/prescription.controller.js`  
The misspelling is consistent across model and controller so it doesn't break anything today, but it is baked into the MongoDB schema and any existing documents.

---

### INFO-003 · No Security Headers — `helmet` Not Used

**File:** `Backend/src/app.js`  
No `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, or `Referrer-Policy` headers are set. These are the first line of defence against XSS and clickjacking.  
**Fix:** `npm install helmet` then `app.use(helmet())`

---

### INFO-004 · Weak Password Policy — Length Only, No Complexity Requirement

**Files:** `patient.model.js:27`, `doctor.model.js:34`, `admin.model.js:20`  
`password: { type: String, minlength: 8 }` accepts `aaaaaaaa` or `12345678`. No uppercase, digit, or special character requirement.

---

### INFO-005 · TempToken Uses `REFRESH_TOKEN_SECRET` — Token Type Confusion Risk

**File:** `Backend/src/controllers/otp.controller.js` · Line 74  
The password-reset temp token is signed with `REFRESH_TOKEN_SECRET`, the same secret used for session refresh tokens. Rotating the refresh secret for security reasons simultaneously invalidates all pending password-reset flows.  
**Fix:** Introduce a dedicated `TEMP_TOKEN_SECRET` environment variable.

---

### INFO-006 · Multer Accepts Any File Type — No MIME-Type Filter

**File:** `Backend/src/middlewares/multer.middleware.js`  
No `fileFilter` is configured. Any file type (`.js`, `.svg`, `.html`, `.exe`) can be uploaded. An `.svg` with an embedded `<script>` tag served from the same origin is a stored-XSS vector.  
**Fix:** Add `fileFilter` restricting to `image/jpeg`, `image/png`, `image/webp`, `application/pdf`.

---

### INFO-007 · Emoji Character in Production Log Statement

**File:** `Backend/src/services/mail.js` · Line 19  
```js
console.log("📧 Email sent:", info.messageId);
```
Emoji can cause encoding issues in log aggregation tools (Splunk, Logstash, CloudWatch) and break regex-based log parsers.

---

## Summary Table

| # | File | Severity | Description |
|---|---|---|---|
| BUG-001 | patient/doctor/admin `.model.js` | **Critical** | Refresh token missing `role` in JWT payload (all 3 models) |
| BUG-002 | patient/doctor/admin `controller.js` | **Critical** | `refreshtoken` not re-selected via `.select("+refreshtoken")` (all 3 controllers) |
| BUG-003 ⭐ | `appointment.controller.js:276` | **High** | IDOR — no ownership check on `getappointment` |
| BUG-004 | `app.js:90` | **High** | No rate limiting on OTP send/verify endpoints |
| BUG-005 | `otp.controller.js:100` | **High** | TempToken (password-reset JWT) exposed in response body |
| BUG-006 | `cron.controller.js:40` | **High** | Cron accesses undefined `patientdetails` → silent TypeError, no emails sent |
| BUG-007 | patient/doctor/admin `controller.js` | **Medium** | Dead `if(!decoded)` after `jwt.verify()` → 500 leaks JWT library error string (all 3) |
| BUG-008 | doctor/admin `controller.js` | **Medium** | `req.cookies \|\| req.body` — body fallback never executes (2 controllers) |
| BUG-009 | `appointment.controller.js:192,230` | **Medium** | No status check on `cancelappointment` and `updateappointment` |
| BUG-010 | `otpgenerator.js:3` | **Medium** | `Math.random()` for OTP — not cryptographically secure |
| BUG-011 | `otp.js:1` | **Medium** | OTPs stored as plaintext in-memory Map, cleared on restart |
| BUG-012 | `patient.model.js:22` | **Medium** | `phonenumber: Number` — leading zeros silently dropped |
| BUG-013 | All 5 Redux slice files | **Medium** | Global `isPending/isRejected` matchers contaminate all slice state |
| BUG-014 | `auth.middleware.js:17` | **Medium** | URL substring role detection — any JWT authenticates to unmatched routes |
| BUG-015 | `app.js:36` | **Low** | CORS `!origin` bypass — requests without Origin header skip allowlist |
| BUG-016 | `appointment.controller.js:68` | **Low** | Past-date booking allowed — no future-date validation |
| BUG-017 | `patient.controller.js:109` | **Low** | HTTP 201 returned but `apiResponse` body says `statusCode: 200` |
| BUG-018 | `patient.controller.js:56` | **Low** | `confirmPassword` field is optional — server-side bypass via API |
| BUG-019 | `appointment.controller.js:56` | **Low** | No doctor shift validation on booking — any time slot accepted |
| BUG-020 | `appointment.controller.js:272` | **Low** | `updateappointment` returns raw unpopulated Mongoose document |
| INFO-001 | `patient.controller.js:360` | Informational | Typo: "Patient not dound" |
| INFO-002 | `prescription.model.js:35` | Informational | Field typo: `diagonosis` throughout schema and controller |
| INFO-003 | `app.js` | Informational | No `helmet` — security headers missing |
| INFO-004 | All 3 user models | Informational | Weak password policy — length only, no complexity |
| INFO-005 | `otp.controller.js:74` | Informational | TempToken shares `REFRESH_TOKEN_SECRET` with session tokens |
| INFO-006 | `multer.middleware.js` | Informational | No file-type filter — any MIME type accepted |
| INFO-007 | `mail.js:19` | Informational | Emoji in production log statement |

---

## Severity Breakdown

```
Critical        ██            2 bugs   (BUG-001, BUG-002)
High            ████          4 bugs   (BUG-003 to BUG-006)
Medium          ████████      8 bugs   (BUG-007 to BUG-014)
Low             ████████████  6 bugs   (BUG-015 to BUG-020)
Informational   ██████████████  7 findings  (INFO-001 to INFO-007)
──────────────────────────────────────────
Total           27 findings (20 main bugs)
```

---

*SmartFit CW2 Security Assignment — Bug Report*
