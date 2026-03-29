/**
 * Transform: Convert Faker property access to method calls
 * Ported from Laravel Shift CLI (MIT)
 *
 * In Faker v2 (required by Laravel 9+), magic properties like $faker->name
 * should be $faker->name() method calls.
 */

// Properties that became methods in Faker v2
const FAKER_PROPERTIES = [
  'name', 'firstName', 'lastName', 'title', 'suffix', 'prefix',
  'email', 'safeEmail', 'freeEmail', 'companyEmail', 'userName',
  'password', 'domainName', 'domainWord', 'url', 'slug', 'ipv4', 'ipv6',
  'localIpv4', 'macAddress',
  'address', 'streetAddress', 'streetName', 'streetSuffix', 'buildingNumber',
  'city', 'citySuffix', 'state', 'stateAbbr', 'postcode', 'country',
  'countryCode', 'latitude', 'longitude',
  'phoneNumber', 'tollFreePhoneNumber', 'e164PhoneNumber',
  'company', 'companySuffix', 'catchPhrase', 'bs', 'jobTitle',
  'creditCardType', 'creditCardNumber', 'creditCardExpirationDate',
  'iban', 'swiftBicNumber',
  'word', 'words', 'sentence', 'sentences', 'paragraph', 'paragraphs', 'text',
  'realText', 'realTextBetween',
  'boolean', 'md5', 'sha1', 'sha256', 'locale', 'countryISOAlpha3',
  'languageCode', 'currencyCode', 'emoji',
  'uuid', 'ean13', 'ean8', 'isbn10', 'isbn13',
  'hexColor', 'safeHexColor', 'rgbColor', 'rgbCssColor', 'safeColorName', 'colorName',
  'mimeType', 'fileExtension',
  'dateTime', 'dateTimeBetween', 'dateTimeThisYear', 'dateTimeThisMonth',
  'dateTimeThisDecade', 'dateTimeThisCentury', 'date', 'time',
  'unixTime', 'iso8601', 'amPm', 'dayOfMonth', 'dayOfWeek', 'month',
  'monthName', 'year', 'century', 'timezone',
  'randomDigit', 'randomDigitNot', 'randomDigitNotNull', 'randomNumber',
  'randomFloat', 'randomLetter',
  'numerify', 'lexify', 'bothify', 'asciify', 'regexify',
];

export default {
  name: 'faker-methods',
  description: 'Convert Faker property access to method calls',
  appliesFrom: '9',
  appliesTo: null,
  glob: '{database/factories,database/seeders,tests}/**/*.php',

  detect(content) {
    // Match $faker->property or $this->faker->property (not followed by "(")
    const props = FAKER_PROPERTIES.join('|');
    const regex = new RegExp(`\\$(?:faker|this->faker)->(?:${props})\\b(?!\\s*\\()`, 'm');
    return regex.test(content);
  },

  transform(content) {
    if (!this.detect(content)) {
      return { content, changed: false, description: '' };
    }

    let count = 0;
    const props = FAKER_PROPERTIES.join('|');
    const regex = new RegExp(
      `(\\$(?:faker|this->faker)->)(${props})\\b(?!\\s*\\()`,
      'g'
    );

    const transformed = content.replace(regex, (_match, prefix, prop) => {
      count++;
      return `${prefix}${prop}()`;
    });

    return {
      content: transformed,
      changed: count > 0,
      description: `Converted ${count} Faker property access(es) to method calls`,
    };
  },
};
