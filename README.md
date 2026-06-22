<div align="center">
  <h1>🏥 Hospital Management System</h1>
  <p><strong>A fullstack MERN application with three role-based portals — Patient, Doctor, and Admin — each with a dedicated frontend and shared backend API</strong></p>

  <p>
    <a href="https://patient-gilt.vercel.app" target="_blank">
      <img src="https://img.shields.io/badge/Patient%20Portal-Live-brightgreen?style=for-the-badge&logo=vercel" />
    </a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/Node.js-Express-339933?style=flat-square&logo=node.js" />
    <img src="https://img.shields.io/badge/MongoDB-Mongoose-47A248?style=flat-square&logo=mongodb" />
    <img src="https://img.shields.io/badge/React-Vite-61DAFB?style=flat-square&logo=react" />
    <img src="https://img.shields.io/badge/JWT-Auth-000000?style=flat-square&logo=jsonwebtokens" />
  </p>
</div>

---

## Overview

This is a fullstack hospital management system with three completely separate React frontends — one for patients, one for doctors, and one for admins — all backed by a single Express.js REST API with role-based access control.

Each role sees a different interface and can only access the endpoints they are authorized for. The backend enforces this at the middleware level using JWT and role verification.

---

## Architecture
```
Hospital-Management/
├── Backend/        # Express.js REST API (shared by all portals)
├── Frontend/       # Patient portal — Vite + React
├── Doctor/         # Doctor portal  — Vite + React
└── Admin/          # Admin portal   — Vite + React
```
```
Patient / Doctor / Admin Frontend
          ↓
    Express.js API
    (JWT + Role Middleware)
          ↓
       MongoDB
```

---

## Role Breakdown

### 🧑‍⚕️ Patient
- Register and login
- Book appointments with available doctors
- View appointment history and status

### 👨‍⚕️ Doctor
- View assigned appointments
- Update appointment status (accept / complete)
- Access patient information for their appointments

### 🔐 Admin
- Manage doctors — add, view, remove
- View and manage all appointments across the system
- Full system oversight

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express.js |
| Database | MongoDB, Mongoose |
| Auth | JWT (role-based) |
| Frontend | React 18, Vite, Tailwind CSS |
| Deployment | Vercel (frontend) |

---

## Key Implementation Details

- **Three separate frontends** — Admin, Doctor, and Patient each have their own Vite + React app pointing to the same backend, keeping role concerns cleanly separated
- **JWT middleware** — every protected route verifies the token and checks the role before allowing access, preventing cross-role data access
- **MVC structure** — backend organized into `models/`, `routes/`, `controllers/` for clear separation of concerns
- **Appointment state machine** — appointments move through defined statuses (pending → accepted → completed) with each role only able to trigger valid transitions

---

## Local Setup
```bash
git clone https://github.com/DipanjanDas27/Hospital-Management.git
```

**Backend:**
```bash
cd Backend
npm install
# create .env with MONGO_URI, JWT_SECRET, PORT
npm run dev
```

**Patient frontend:**
```bash
cd Frontend
npm install
npm run dev
```

**Doctor frontend:**
```bash
cd Doctor
npm install
npm run dev
```

**Admin frontend:**
```bash
cd Admin
npm install
npm run dev
```

---

## Live Demo

| Portal | URL |
|---|---|
| Patient | [patient-gilt.vercel.app](https://patient-gilt.vercel.app) |
| Doctor | Deploy separately from `/Doctor` folder |
| Admin | Deploy separately from `/Admin` folder |

---

## Author

**Dipanjan Das**
📩 dipanjandas2758@gmail.com
🔗 [GitHub](https://github.com/DipanjanDas27) · [LinkedIn](https://www.linkedin.com/in/dipanjan-das-65b023290/)
