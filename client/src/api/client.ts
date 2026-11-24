import axios from 'axios';

export const api = axios.create({
  baseURL: '/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('clawbot_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let isReloading = false;

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('clawbot_token');
      localStorage.removeItem('clawbot_user');
      if (!isReloading && window.location.pathname !== '/login') {
        isReloading = true;
        window.location.reload();
      }
    }
    return Promise.reject(error);
  }
);
