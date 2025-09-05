import jwt from 'jsonwebtoken';

const role = process.argv.includes('--admin') ? 'admin' : 'buyer';
const secret = process.env.JWT_SECRET || 'dev-secret';  
const payload = {
  sub: 'demo-user',
  role,                    
  iss: process.env.JWT_ISS || 'ruhutickets',
  aud: process.env.JWT_AUD || 'ruhutickets-ui'
};
const token = jwt.sign(payload, secret, { expiresIn: '8h' });
console.log(token);
