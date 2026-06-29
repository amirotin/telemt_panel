import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import ru from './ru.json';

const supportedLanguages = ['en', 'ru'];

function detectLanguage() {
  const savedLang = localStorage.getItem('lang');
  if (savedLang && supportedLanguages.includes(savedLang)) {
    return savedLang;
  }

  const browserLang = navigator.language.split('-')[0];
  return supportedLanguages.includes(browserLang) ? browserLang : 'en';
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ru: { translation: ru },
    },
    lng: detectLanguage(),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

export default i18n;
