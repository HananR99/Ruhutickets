#!/usr/bin/env node
import jwt from 'jsonwebtoken';

const role = process.argv.includes('--admin') ? 'admin' : 'buyer';
const secret = process.env.JWT_SECRET || 'dev-secret';  // must match compose
const payload = {
  sub: 'demo-user',
  role,                    // 'buyer' | 'admin'
  iss: process.env.JWT_ISS || 'ruhutickets',
  aud: process.env.JWT_AUD || 'ruhutickets-ui'
};
const token = jwt.sign(payload, secret, { expiresIn: '8h' });
console.log(token);
