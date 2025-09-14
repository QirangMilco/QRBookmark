/**
 * 同步管理器
 * 负责管理书签的同步功能
 */
class SyncManager {
    constructor() {
        this.changeManager = new LocalChangeManager(this);
        this.isSyncing = false;
        this.BATCH_SIZE = 50; // 每批同步的书签数量
    }

    async getSyncVersion() {
        return await LocalStorageMgr.get('lastSyncVersion') || 0;
    }

    async cleanup() {
        logger.info('清理同步状态');
        await this.changeManager.cleanup();
        this.isSyncing = false;
    }

    async resetSyncCache() {
        await LocalStorageMgr.remove(['lastSyncVersion']);
    }

    // 初始化同步
    async startSync() {
        // 如果是第一次同步(版本号为0),则需要同步所有本地书签
        const lastSyncVersion = await this.getSyncVersion();
        if (lastSyncVersion === 0) {
            return await this.syncAllLocalBookmarks();
        }else {
            return await this.syncChange();
        }
    }

    // 记录书签变更
    async recordBookmarkChange(bookmarks, isDeleted = false) {
        // 支持单个书签或书签数组
        const bookmarkArray = Array.isArray(bookmarks) ? bookmarks : [bookmarks];
        const lastSyncVersion = await this.getSyncVersion();

        logger.debug('记录书签变更', {
            bookmarks: bookmarkArray,
            isDeleted: isDeleted,
            lastSyncVersion: lastSyncVersion
        });
        
        if (lastSyncVersion !== 0) {
            // 批量添加变更
            await this.changeManager.addChange(bookmarkArray, isDeleted);
        }
    }

    // 检查是否可以同步
    async canSync() {
        const online = navigator.onLine;
        if (!online) {
            return false;
        }

        // 已移除云同步功能，此方法不再需要验证token
        return true;
    }

    // 同步本地修改
    async syncChange() {
        if (this.isSyncing) {
            throw new Error('同步正在进行中');
        }
        this.isSyncing = true;

        try {
            if (!await this.canSync()) {
                logger.warn('无法同步: 离线');
                throw new Error('网络连接不可用，请检查网络连接');
            }

            const result = {
                lastSync: new Date().getTime(),
                lastSyncResult: 'success',
            }

            const pendingChanges = await this.changeManager.getPendingChanges();
            const changes = Object.values(pendingChanges).map(item => item.change);

            logger.info('开始同步变更, 变更数:', changes.length);

            const lastSyncVersion = await this.getSyncVersion();
            
            // 已移除云同步功能，不再向服务器发送同步请求
            // 直接更新本地同步版本号
            await LocalStorageMgr.set('lastSyncVersion', Date.now());

            // 清空已同步的变更
            await this.changeManager.clearChanges();

            logger.info('同步变更完成');

            return result;
        } catch (error) {
            logger.error('同步变更失败:', error);
            throw error;
        } finally {
            await this.changeManager.mergeTempQueueToStorage();
            this.isSyncing = false;
        }
    }

    // 同步所有本地书签
    async syncAllLocalBookmarks() {
        logger.info('同步本地书签');

        if (this.isSyncing) {
            logger.warn('同步正在进行中');
            throw new Error('同步正在进行中');
        }
        this.isSyncing = true;

        try {
            if (!await this.canSync()) {
                throw new Error('网络连接不可用，请检查网络连接');
            }

            const result = {
                lastSync: new Date().getTime(),
                lastSyncResult: 'success',
            }

            // 获取所有本地书签
            const localBookmarks = await LocalStorageMgr.getBookmarks();
            
            // 转换为服务器格式的书签列表
            const changes = Object.values(localBookmarks)
                .map(bookmark => this.convertToServerFormat(bookmark));

            logger.info('开始同步所有本地书签, 书签数:', changes.length);

            // 执行同步
            const lastSyncVersion = await this.getSyncVersion();
            
            // 已移除云同步功能，不再向服务器发送同步请求
            // 直接更新本地同步版本号
            await LocalStorageMgr.set('lastSyncVersion', Date.now());
            
            logger.info('同步本地书签完成');

            return result;
        } catch (error) {
            logger.error('同步本地书签失败:', error);
            throw error;
        } finally {
            this.isSyncing = false;
        }
    }

    // 转换书签格式为服务器格式
    convertToServerFormat(bookmark) {
        return {
            id: bookmark.id,
            url: bookmark.url,
            title: bookmark.title,
            tags: bookmark.tags || [],
            excerpt: bookmark.excerpt || '',
            createdAt: bookmark.createdAt,
            updatedAt: bookmark.updatedAt,
            deleted: false
        };
    }
}

class LocalChangeManager {
    constructor(syncManager) {
        this.syncManager = syncManager;
        this.STORAGE_KEY = 'pendingChanges';
        this.tempQueue = new Map(); // 添加临时队列
    }

    async cleanup() {
        this.tempQueue.clear();
        await this.clearChanges();
    }

    // 获取待同步的变更列表
    async getPendingChanges() {
        const changes = await LocalStorageMgr.get(this.STORAGE_KEY) || {};
        return changes;
    }

    // 添加一个变更到列表
    async addChange(bookmarks, isDeleted = false) {
        // 统一转换为数组处理
        const bookmarkArray = Array.isArray(bookmarks) ? bookmarks : [bookmarks];
        
        // 如果是空数组则直接返回
        if (bookmarkArray.length === 0) return;
        
        // 生成所有变更记录
        const changeEntries = bookmarkArray.map(bookmark => {
            const change = {
                timestamp: Date.now(),
                change: this.syncManager.convertToServerFormat(bookmark, isDeleted)
            };
            return [bookmark.url, change];
        });

        if (this.syncManager.isSyncing) {
            // 如果正在同步，添加到临时队列
            changeEntries.forEach(([url, change]) => {
                this.tempQueue.set(url, change);
            });
            logger.info('同步进行中，批量变更已添加到临时队列，数量:', bookmarkArray.length);
        } else {
            // 如果没有同步，直接添加到存储
            const changes = await this.getPendingChanges();
            changeEntries.forEach(([url, change]) => {
                changes[url] = change;
            });
            await LocalStorageMgr.set(this.STORAGE_KEY, changes);
            logger.info('批量变更已保存到存储，数量:', bookmarkArray.length);
        }
    }

    // 移除一个变更
    async removeChange(url) {
        const changes = await this.getPendingChanges();
        delete changes[url];
        await LocalStorageMgr.set(this.STORAGE_KEY, changes);
    }

    // 清空变更列表
    async clearChanges() {
        await LocalStorageMgr.set(this.STORAGE_KEY, {});
    }

    async mergeTempQueueToStorage() {
        // 处理临时队列中的变更
        if (this.tempQueue.size > 0) {
            logger.info('处理临时队列中的变更，数量:', this.tempQueue.size);
            const changes = {};
            for (const [url, change] of this.tempQueue.entries()) {
                changes[url] = change;
            }
            await LocalStorageMgr.set(this.STORAGE_KEY, changes);
            this.tempQueue.clear();
        }
    }

    // 获取变更列表大小
    async getChangeCount() {
        const changes = await this.getPendingChanges();
        return Object.keys(changes).length;
    }
}

const syncManager = new SyncManager();