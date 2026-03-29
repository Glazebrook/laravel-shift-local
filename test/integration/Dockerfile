FROM php:8.3-cli

# Install Composer
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

# Install Node.js 22 and git
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs git \
    && npm install -g npm@latest

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .

CMD ["npm", "run", "test:integration"]
