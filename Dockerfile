FROM node:20-slim

WORKDIR /usr/src/app

COPY . .

ENV NODE_ENV=production

RUN npm install

CMD [ "npm", "run", "bot" ]
