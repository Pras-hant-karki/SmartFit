import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api/v1/patient",
  withCredentials: true, 
  timeout: 10000,
});

const PATIENT_ACCESS_TOKEN_KEY = "smartfit_patient_access_token";

let isRefreshing = false;
let failedQueue = [];

const processQueue = (error) => {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else resolve();
  });
  failedQueue = [];
};

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(PATIENT_ACCESS_TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (
      !error.response ||
      error.response.status !== 401 ||
      originalRequest.url.includes("renew-access-token")
    ) {
      return Promise.reject(error);
    }

    if (originalRequest._retry) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({
          resolve: () => resolve(api(originalRequest)),
          reject,
        });
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      const renewResponse = await api.post("/renew-access-token");
      const newAccessToken = renewResponse.data?.data?.accesstoken;
      if (newAccessToken) {
        localStorage.setItem(PATIENT_ACCESS_TOKEN_KEY, newAccessToken);
      }

      processQueue(null);
      isRefreshing = false;

      return api(originalRequest);
    } catch (refreshError) {
      processQueue(refreshError);
      isRefreshing = false;
      localStorage.removeItem(PATIENT_ACCESS_TOKEN_KEY);

      return Promise.reject(refreshError);
    }
  }
);
export default api;
