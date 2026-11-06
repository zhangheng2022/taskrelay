/** 网站接口的可推导路由组合；统一鉴权、来源和错误处理由外层应用保留，客户端只引用此类型。 */
import {Hono} from 'hono';
import {user} from './user';
import {admin} from './admin';
import {conversations} from './ai/conversations';
export const browserApi=new Hono().route('/api/user',user).route('/api/user',conversations).route('/api/admin',admin);
export type BrowserApi=typeof browserApi;
export default browserApi;
