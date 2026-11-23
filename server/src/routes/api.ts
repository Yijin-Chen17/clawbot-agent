import { Router } from 'express';
import { register, login, getMe, updateProfile, uploadAvatar, changePassword, sendRegisterCode, checkUsername, deleteMyAccount } from '../controllers/authController.js';
import {
  listUsers,
  approveUser,
  rejectUser,
  banUser,
  unbanUser,
  setUserRole,
  deleteUser,
  getDebugLogs,
  clearDebugLogs,
  debugSimulateInbound,
  debugTestSendWeChat,
  getWorkersStatus,
  restartUserWorker,
  resetUserSyncBuf,
  getGlobalLlmSettings,
  updateGlobalLlmSettings,
  testGlobalLlmSettings,
  rechargeUserBalance,
  generateRedemptionCodes,
  listRedemptionCodes,
  deleteRedemptionCode,
  getAdminUsageStats,
} from '../controllers/adminController.js';
import {
  getSettings,
  updateSettings,
  regenerateWebhookToken,
  testLlmApiKey,
  getLlmUsage,
  clearLlmUsage,
  redeemCode,
} from '../controllers/settingsController.js';
import { listTasks, createTask, updateTask, deleteTask, rescheduleTask, quickActionTask, completePartTask, applyProposal } from '../controllers/taskController.js';
import {
  listSubscriptions,
  createSubscription,
  deleteSubscription,
  syncSubscriptionNow,
  updateCalendarColor,
  getCalendarEvents,
  exportDedicatedIcal,
  syncAndReplanAll,
  replanAll,
  previewTodoCard,
} from '../controllers/calendarController.js';
import { handleClawbotWebhook } from '../controllers/webhookController.js';
import { getQRCode, getStatus, unbindWeixin, sendTestMessage } from '../controllers/weixinController.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

export const router = Router();

// ================= Public Routes =================
router.get('/auth/check-username', checkUsername);
router.post('/auth/send-code', sendRegisterCode);
router.post('/auth/register', register);
router.post('/auth/login', login);
router.get('/calendar/subscribe/:token', exportDedicatedIcal);
router.get('/calendar/subscribe/:token.ics', exportDedicatedIcal);
router.get('/calendar/export/:token', exportDedicatedIcal);
router.get('/calendar/export/:token.ics', exportDedicatedIcal);
router.post('/webhook/clawbot/:token', handleClawbotWebhook);

// ================= Protected Routes =================
router.get('/auth/me', requireAuth, getMe);
router.delete('/auth/me', requireAuth, deleteMyAccount);
router.put('/auth/profile', requireAuth, updateProfile);
router.post('/auth/avatar', requireAuth, uploadAvatar);
router.put('/auth/password', requireAuth, changePassword);

// User Settings
router.get('/settings', requireAuth, getSettings);
router.put('/settings', requireAuth, updateSettings);
router.post('/settings/test-llm', requireAuth, testLlmApiKey);
router.get('/settings/llm-usage', requireAuth, getLlmUsage);
router.delete('/settings/llm-usage', requireAuth, clearLlmUsage);
router.post('/settings/regenerate-token', requireAuth, regenerateWebhookToken);
router.post('/settings/redeem-code', requireAuth, redeemCode);

// WeChat Clawbot iLink Gateway & QR Code Scan
router.get('/weixin/qrcode', requireAuth, getQRCode);
router.get('/weixin/status', requireAuth, getStatus);
router.post('/weixin/unbind', requireAuth, unbindWeixin);
router.post('/weixin/test-message', requireAuth, sendTestMessage);

// Task / TODO Management
router.get('/tasks', requireAuth, listTasks);
router.post('/tasks', requireAuth, createTask);
router.put('/tasks/:id', requireAuth, updateTask);
router.delete('/tasks/:id', requireAuth, deleteTask);
router.post('/tasks/:id/reschedule', requireAuth, rescheduleTask);
router.post('/tasks/apply-proposal', requireAuth, applyProposal);
router.post('/tasks/:id/action', requireAuth, quickActionTask);
router.post('/tasks/:id/complete-part', requireAuth, completePartTask);

// Calendar Management
router.get('/calendar/subscriptions', requireAuth, listSubscriptions);
router.put('/calendar/colors/:id', requireAuth, updateCalendarColor);
router.post('/calendar/subscriptions', requireAuth, createSubscription);
router.delete('/calendar/subscriptions/:id', requireAuth, deleteSubscription);
router.post('/calendar/subscriptions/:id/sync', requireAuth, syncSubscriptionNow);
router.get('/calendar/events', requireAuth, getCalendarEvents);
router.post('/calendar/sync-and-replan', requireAuth, syncAndReplanAll);
router.post('/calendar/replan', requireAuth, replanAll);
router.get('/calendar/preview-todo-card', requireAuth, previewTodoCard);

// ================= Admin Routes =================
router.get('/admin/users', requireAdmin, listUsers);
router.put('/admin/users/:id/approve', requireAdmin, approveUser);
router.put('/admin/users/:id/reject', requireAdmin, rejectUser);
router.put('/admin/users/:id/ban', requireAdmin, banUser);
router.put('/admin/users/:id/unban', requireAdmin, unbanUser);
router.put('/admin/users/:id/role', requireAdmin, setUserRole);
router.delete('/admin/users/:id', requireAdmin, deleteUser);

// Admin Debugger Routes
router.get('/admin/debug/logs', requireAdmin, getDebugLogs);
router.delete('/admin/debug/logs', requireAdmin, clearDebugLogs);
router.post('/admin/debug/simulate-inbound', requireAdmin, debugSimulateInbound);
router.post('/admin/debug/test-send-wechat', requireAdmin, debugTestSendWeChat);
router.get('/admin/debug/workers', requireAdmin, getWorkersStatus);
router.post('/admin/debug/workers/:userId/restart', requireAdmin, restartUserWorker);
router.post('/admin/debug/workers/:userId/reset-sync', requireAdmin, resetUserSyncBuf);

// Admin Global LLM & Balance & Redemption Routes
router.get('/admin/global-llm', requireAdmin, getGlobalLlmSettings);
router.put('/admin/global-llm', requireAdmin, updateGlobalLlmSettings);
router.post('/admin/global-llm/test', requireAdmin, testGlobalLlmSettings);
router.post('/admin/users/:id/recharge', requireAdmin, rechargeUserBalance);
router.post('/admin/users/recharge', requireAdmin, rechargeUserBalance);
router.post('/admin/redemption-codes/generate', requireAdmin, generateRedemptionCodes);
router.get('/admin/redemption-codes', requireAdmin, listRedemptionCodes);
router.delete('/admin/redemption-codes/:id', requireAdmin, deleteRedemptionCode);
router.get('/admin/usage-stats', requireAdmin, getAdminUsageStats);
