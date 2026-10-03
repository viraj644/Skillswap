# SkillSwap

An intra-college peer-to-peer skill barter system. Students teach the skills they know and learn the ones they need, using virtual credits instead of money.

## Features

- Registration limited to college email addresses, with JWT login and bcrypt password hashing
- Student profiles with photo, bio, availability, skills offered and skills wanted
- Skill search by category and a matching engine that highlights mutual swaps
- Credit wallet with escrow while a session is booked, and a full transaction history
- Booking workflow: request, accept or decline, confirmation code, completion
- Ratings, reviews and a tutor reputation score
- Admin panel to monitor usage and suspend accounts

## Tech stack

- Frontend: HTML, CSS, JavaScript
- Backend: Node.js, Express
- Database: SQLite (built into Node.js)
- Security: JSON Web Tokens, bcryptjs

## Project structure

```
skillswap-project
├── backend
│   ├── package.json
│   └── server.js
└── frontend
    └── index.html
```

## Run locally

Requires Node.js 22.13 or higher.

```
cd backend
npm install
npm start
```

Open http://localhost:3000 in your browser.

## Configuration

- The allowed email ending is set by `DOMAIN` in `backend/server.js`.
- Set a `JWT_SECRET` environment variable when deploying.
- An admin account is created on the first run. Change its password in `backend/server.js` before hosting the app publicly.
