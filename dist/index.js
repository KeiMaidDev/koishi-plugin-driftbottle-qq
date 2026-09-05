// client/app.ts
import { message, messageBox } from "@koishijs/client";
import { defineComponent, h, onMounted, reactive, ref, resolveComponent, watch } from "vue";

// client/api.ts
import { receive, send } from "@koishijs/client";
var onPanelChange = (listener) => receive("driftbottle-console/changed", listener);
var fetchStats = () => send("driftbottle-console/stats");
var fetchList = (query) => send("driftbottle-console/list", query);
var fetchBottle = (id) => send("driftbottle-console/bottle", id);
var banBottle = (id) => send("driftbottle-console/ban", id);
var unbanBottle = (id) => send("driftbottle-console/unban", id);
var deleteReview = (id, reviewIndex) => send("driftbottle-console/delete-review", id, reviewIndex);
var dismissReport = (id) => send("driftbottle-console/dismiss-report", id);
var fetchMediaToken = () => send("driftbottle-console/media-token");
var fetchPendingList = () => send("driftbottle-console/pending-list");
var fetchPendingDetail = (pendingId) => send("driftbottle-console/pending-detail", pendingId);
var approvePending = (pendingId) => send("driftbottle-console/approve-pending", pendingId);
var rejectPending = (pendingId, reason) => send("driftbottle-console/reject-pending", pendingId, reason);

// client/app.ts
var el = (name) => resolveComponent(name);
var COLORS = {
  danger: "#f56c6c",
  info: "#909399",
  success: "#67c23a"
};
function errText(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function formatTime(time) {
  if (!time) return "—";
  return new Date(time).toLocaleString("zh-CN", { hour12: false });
}
var app_default = defineComponent({
  name: "DriftbottlePanel",
  setup() {
    const activeTab = ref("bottles");
    const stats = ref(null);
    const list = ref(null);
    const query = reactive({
      filter: "all",
      search: "",
      page: 1,
      pageSize: 20
    });
    const searchInput = ref("");
    const detail = ref(null);
    const detailLoading = ref(false);
    const audioBroken = ref(false);
    const mediaToken = ref("");
    const pendingList = ref(null);
    const pendingDetail = ref(null);
    const pendingDetailLoading = ref(false);
    const mediaUrl = (url) => {
      if (!url || !url.startsWith("/")) return url;
      if (!mediaToken.value) return url;
      return url + (url.includes("?") ? "&" : "?") + "token=" + mediaToken.value;
    };
    async function refreshStatsAndList() {
      try {
        const [nextStats, nextList] = await Promise.all([
          fetchStats(),
          fetchList({ ...query })
        ]);
        stats.value = nextStats;
        list.value = nextList;
      } catch (error) {
        message.error("加载漂流瓶数据失败：" + errText(error));
      }
    }
    async function refreshDetail() {
      const current = detail.value;
      if (!current) return;
      try {
        const next = await fetchBottle(current.id);
        if (detail.value?.id === current.id) {
          detail.value = next;
          audioBroken.value = false;
        }
      } catch (error) {
        message.error("加载瓶子详情失败：" + errText(error));
      }
    }
    async function refreshPending() {
      try {
        pendingList.value = await fetchPendingList();
      } catch (error) {
        message.error("加载待审投稿失败：" + errText(error));
      }
    }
    async function refreshPendingDetail() {
      const current = pendingDetail.value;
      if (!current) return;
      try {
        const next = await fetchPendingDetail(current.pendingId);
        if (pendingDetail.value?.pendingId === current.pendingId) {
          pendingDetail.value = next;
          audioBroken.value = false;
        }
      } catch (error) {
        message.error("加载投稿详情失败：" + errText(error));
      }
    }
    async function openPendingDetail(row) {
      pendingDetailLoading.value = true;
      pendingDetail.value = null;
      try {
        pendingDetail.value = await fetchPendingDetail(row.pendingId);
      } catch (error) {
        message.error("加载投稿详情失败：" + errText(error));
      } finally {
        pendingDetailLoading.value = false;
      }
    }
    async function openDetail(row) {
      detailLoading.value = true;
      try {
        const next = await fetchBottle(row.id);
        detail.value = next;
        audioBroken.value = false;
      } catch (error) {
        message.error("加载瓶子详情失败：" + errText(error));
      } finally {
        detailLoading.value = false;
      }
    }
    async function confirmThen(text, run, successText = "操作成功") {
      try {
        await messageBox.confirm(text, "操作确认", {
          type: "warning",
          confirmButtonText: "确认",
          cancelButtonText: "取消"
        });
      } catch {
        return;
      }
      try {
        await run();
        message.success(successText);
      } catch (error) {
        message.error(errText(error));
      }
      await refreshStatsAndList();
      await refreshDetail();
    }
    const banBottle2 = (d) => confirmThen(`确认封禁瓶子 #${d.id} 吗？封禁后普通用户将无法捞到该瓶子，相关举报会被标记为已处理。`, () => banBottle(d.id), "已封禁");
    const unbanBottle2 = (d) => confirmThen(`确认解封瓶子 #${d.id} 吗？解封后该瓶子恢复对普通用户可见。`, () => unbanBottle(d.id), "已解封");
    const dismissReport2 = (d) => confirmThen(`确认忽略瓶子 #${d.id} 的举报吗？该瓶子不会被封禁，举报记录将闭环、不再重复提醒。`, () => dismissReport(d.id), "已忽略举报");
    const deleteReview2 = (d, review) => confirmThen(`确认删除瓶子 #${d.id} 中 ${review.userId || "匿名用户"} 的留言吗？`, () => deleteReview(d.id, review.index), "留言已删除");
    const approvePendingAction = async (pending) => {
      try {
        await messageBox.confirm(`确认通过待审投稿 #${pending.pendingId} 吗？通过后投稿将转正为瓶子入海。`, "操作确认", {
          type: "warning",
          confirmButtonText: "确认",
          cancelButtonText: "取消"
        });
      } catch {
        return;
      }
      try {
        await approvePending(pending.pendingId);
        message.success("投稿已通过");
      } catch (error) {
        message.error(errText(error));
      }
      await refreshPending();
      await refreshStatsAndList();
      await refreshPendingDetail();
    };
    const rejectPendingAction = async (pending) => {
      let reason;
      try {
        const input = await messageBox.prompt(`请输入待审投稿 #${pending.pendingId} 的驳回理由（可留空）：`, "驳回投稿", {
          type: "warning",
          confirmButtonText: "驳回",
          cancelButtonText: "取消",
          inputPlaceholder: "不填写理由则作者不会收到驳回原因"
        });
        reason = (input?.value ?? "").trim();
      } catch {
        return;
      }
      try {
        await rejectPending(pending.pendingId, reason);
        message.success("投稿已驳回");
      } catch (error) {
        message.error(errText(error));
      }
      await refreshPending();
      await refreshStatsAndList();
      await refreshPendingDetail();
    };
    function applySearch() {
      query.search = searchInput.value.trim();
      query.page = 1;
    }
    function onFilterChange(value) {
      query.filter = value;
      query.page = 1;
    }
    watch(query, () => refreshStatsAndList());
    onMounted(async () => {
      onPanelChange(() => {
        refreshStatsAndList();
        refreshDetail();
        refreshPending();
        refreshPendingDetail();
      });
      try {
        mediaToken.value = await fetchMediaToken();
      } catch {
      }
      await refreshStatsAndList();
    });
    const statItem = (label, value, color, onClick) => h("div", {
      style: `min-width:88px;text-align:center;${onClick ? "cursor:pointer;" : ""}`,
      onClick
    }, [
      h("div", { style: `font-size:22px;font-weight:600;color:${color}` }, value === void 0 ? "—" : String(value)),
      h("div", { style: "font-size:12px;color:#909399;margin-top:2px" }, label)
    ]);
    const placeholder = (text) => h("div", {
      style: "width:96px;height:96px;display:flex;align-items:center;justify-content:center;border:1px dashed #dcdfe6;border-radius:4px;color:#909399;font-size:12px;text-align:center"
    }, text);
    const mediaImage = (url, key) => url ? h(el("el-image"), {
      key,
      src: mediaUrl(url),
      fit: "cover",
      lazy: true,
      previewSrcList: [mediaUrl(url)],
      previewTeleported: true,
      style: "width:96px;height:96px;border-radius:4px"
    }) : placeholder("图片不可用");
    const statusTag = (text, type) => h(el("el-tag"), { type, size: "small", style: "margin-left:6px" }, () => text);
    const column = (prop, label, props = {}) => h(el("el-table-column"), { prop, label, ...props });
    const renderListPane = () => {
      const bottles = list.value?.bottles ?? [];
      return h("div", { style: "flex:1.4;min-width:280px" }, [
        h(el("el-table"), {
          data: bottles,
          size: "small",
          highlightCurrentRow: true,
          onRowClick: openDetail,
          style: "width:100%"
        }, () => [
          column("id", "ID", { width: 70 }),
          column("authorId", "作者", { width: 140, showOverflowTooltip: true }),
          column("type", "类型", { width: 90 }),
          column("preview", "内容摘要", { showOverflowTooltip: true }),
          column("reviewCount", "留言", { width: 65 }),
          h(el("el-table-column"), { label: "举报", width: 80 }, {
            default: ({ row }) => row.reportCount > 0 ? h(el("el-tag"), { type: row.reportPending ? "danger" : "info", size: "small" }, () => String(row.reportCount)) : h("span", "—")
          }),
          h(el("el-table-column"), { label: "状态", width: 80 }, {
            default: ({ row }) => h(el("el-tag"), { type: row.show ? "success" : "warning", size: "small" }, () => row.show ? "正常" : "已封禁")
          })
        ]),
        bottles.length ? h(el("el-pagination"), {
          layout: "total, prev, pager, next",
          total: list.value?.total ?? 0,
          currentPage: query.page,
          pageSize: query.pageSize,
          "onCurrentChange": (page) => {
            query.page = page;
          },
          style: "margin-top:10px;justify-content:flex-end"
        }) : h(el("el-empty"), { description: "没有符合条件的瓶子", imageSize: 80 })
      ]);
    };
    const renderAudio = (url) => audioBroken.value ? h("div", { style: "display:flex;gap:10px;align-items:center" }, [
      placeholder("音频无法在线播放"),
      h("a", { href: mediaUrl(url), target: "_blank", rel: "noopener" }, "下载音频")
    ]) : h("audio", {
      controls: true,
      src: mediaUrl(url),
      style: "width:100%",
      onError: () => {
        audioBroken.value = true;
      }
    });
    const renderReviews = (d) => {
      if (!d.reviews.length) {
        return h("div", { style: "color:#909399;font-size:13px" }, "该瓶子下还没有留言。");
      }
      return h("div", { style: "display:flex;flex-direction:column;gap:10px" }, d.reviews.map(
        (review) => h("div", {
          key: review.index,
          style: `border:1px solid #ebeef5;border-radius:4px;padding:8px 10px;${review.isDel ? "opacity:0.65;background:#fafafa;" : ""}`
        }, [
          h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, [
            h("span", { style: "font-weight:500" }, review.userId || "匿名用户"),
            h("span", { style: "font-size:12px;color:#909399" }, formatTime(review.creatTime)),
            review.isDel ? statusTag("已删除", "info") : null,
            !review.isDel ? h(el("el-button"), {
              size: "small",
              type: "danger",
              plain: true,
              onClick: () => deleteReview2(d, review)
            }, () => "删除") : null
          ]),
          review.text ? h("div", { style: "white-space:pre-wrap;margin-top:4px;font-size:13px" }, review.text) : null,
          review.images.length ? h(
            "div",
            { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:6px" },
            review.images.map((url, index) => mediaImage(url, index))
          ) : null
        ])
      ));
    };
    const renderDetailPane = () => {
      const d = detail.value;
      if (detailLoading.value) {
        return h(el("el-card"), { shadow: "never", style: "flex:1;min-width:280px" }, () => "正在加载详情...");
      }
      if (!d) {
        return h(el("el-card"), { shadow: "never", style: "flex:1;min-width:280px" }, () => h(el("el-empty"), { description: "点击左侧瓶子查看详情" }));
      }
      return h(el("el-card"), { shadow: "never", style: "flex:1;min-width:280px" }, () => h("div", { style: "display:flex;flex-direction:column;gap:12px" }, [
        // 头部：编号 + 徽标 + 操作按钮
        h("div", [
          h("span", { style: "font-weight:600;font-size:16px;margin-right:6px" }, "#" + d.id),
          statusTag(d.type, "primary"),
          statusTag(d.show ? "正常" : "已封禁", d.show ? "success" : "warning"),
          d.reportCount > 0 ? statusTag("举报 " + d.reportCount + (d.reportPending ? " · 待处理" : " · 已处理"), d.reportPending ? "danger" : "info") : null
        ]),
        h(
          "div",
          { style: "font-size:13px;color:#606266" },
          `作者：${d.authorId || "匿名"}　·　发布于 ${formatTime(d.creatTime)}　·　被捞 ${d.getCount} 次`
        ),
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [
          d.show ? h(el("el-button"), { size: "small", type: "danger", plain: true, onClick: () => banBottle2(d) }, () => "封禁瓶子") : h(el("el-button"), { size: "small", type: "success", plain: true, onClick: () => unbanBottle2(d) }, () => "解封瓶子"),
          d.reportCount > 0 ? h(el("el-button"), { size: "small", type: "warning", plain: true, onClick: () => dismissReport2(d) }, () => "忽略举报") : null
        ]),
        // 正文
        d.title ? h("div", { style: "font-weight:600" }, d.title) : null,
        d.text ? h("div", { style: "white-space:pre-wrap;font-size:14px;line-height:1.6" }, d.text) : null,
        d.images.length ? h("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }, d.images.map((url, index) => mediaImage(url, index))) : null,
        d.audio ? renderAudio(d.audio) : null,
        // 留言区
        h("div", { style: "font-weight:600;font-size:14px;border-top:1px solid #ebeef5;padding-top:10px" }, "留言"),
        renderReviews(d)
      ]));
    };
    const renderPendingListPane = () => {
      const pendings = pendingList.value?.pendings ?? [];
      return h("div", { style: "flex:1.4;min-width:280px" }, [
        pendings.length ? h(el("el-table"), {
          data: pendings,
          size: "small",
          highlightCurrentRow: true,
          onRowClick: openPendingDetail,
          style: "width:100%"
        }, () => [
          h(el("el-table-column"), { prop: "pendingId", label: "待审编号", width: 90 }),
          h(el("el-table-column"), { prop: "authorId", label: "作者", width: 140, showOverflowTooltip: true }),
          h(el("el-table-column"), { prop: "type", label: "类型", width: 90 }),
          h(el("el-table-column"), { prop: "preview", label: "内容摘要", showOverflowTooltip: true }),
          h(el("el-table-column"), { label: "时间", width: 150 }, {
            default: ({ row }) => formatTime(row.createdAt)
          }),
          h(el("el-table-column"), { label: "操作", width: 140 }, {
            default: ({ row }) => [
              h(el("el-button"), {
                size: "small",
                type: "success",
                plain: true,
                onClick: (event) => {
                  event.stopPropagation();
                  approvePendingAction(row);
                }
              }, () => "通过"),
              h(el("el-button"), {
                size: "small",
                type: "danger",
                plain: true,
                onClick: (event) => {
                  event.stopPropagation();
                  rejectPendingAction(row);
                }
              }, () => "驳回")
            ]
          })
        ]) : h(el("el-empty"), { description: "当前没有待审投稿", imageSize: 60 })
      ]);
    };
    const renderPendingDetailPane = () => {
      const d = pendingDetail.value;
      if (pendingDetailLoading.value) {
        return h(el("el-card"), { shadow: "never", style: "flex:1;min-width:280px" }, () => "正在加载详情...");
      }
      if (!d) {
        return h(el("el-card"), { shadow: "never", style: "flex:1;min-width:280px" }, () => h(el("el-empty"), { description: "点击左侧待审投稿查看详情" }));
      }
      return h(el("el-card"), { shadow: "never", style: "flex:1;min-width:280px" }, () => h("div", { style: "display:flex;flex-direction:column;gap:10px" }, [
        h("div", [
          h("span", { style: "font-weight:600;font-size:16px;margin-right:6px" }, "#" + d.pendingId),
          statusTag(d.type, "primary"),
          d.notifyAuthor ? statusTag("订阅结果推送", "info") : null
        ]),
        h(
          "div",
          { style: "font-size:13px;color:#606266" },
          `作者：${d.authorId || "匿名"}　·　提交于 ${formatTime(d.createdAt)}`
        ),
        d.title ? h("div", { style: "font-weight:600" }, d.title) : null,
        d.text ? h("div", { style: "white-space:pre-wrap;font-size:14px;line-height:1.6" }, d.text) : null,
        d.images.length ? h("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }, d.images.map((url, index) => mediaImage(url, index))) : null,
        d.audio ? renderAudio(d.audio) : null,
        h("div", { style: "display:flex;gap:8px" }, [
          h(el("el-button"), { size: "small", type: "success", plain: true, onClick: () => approvePendingAction(d) }, () => "通过"),
          h(el("el-button"), { size: "small", type: "danger", plain: true, onClick: () => rejectPendingAction(d) }, () => "驳回")
        ])
      ]));
    };
    return () => {
      const st = stats.value;
      return h(el("k-layout"), () => h("div", { style: "padding:16px;display:flex;flex-direction:column;gap:12px;height:100%;box-sizing:border-box" }, [
        // 顶部统计条（两个 Tab 共享；待审投稿可点击跳转）
        h("div", {
          style: "display:flex;gap:24px;align-items:center;flex-wrap:wrap;background:#fff;border:1px solid #ebeef5;border-radius:6px;padding:12px 20px"
        }, [
          statItem("瓶子总数", st?.total, "#303133"),
          statItem("正常", st?.visible, COLORS.success),
          statItem("已封禁", st?.banned, COLORS.info),
          statItem("待处理举报", st?.pendingReports, st?.pendingReports ? COLORS.danger : COLORS.success),
          statItem("待审投稿", st?.pendingSubmissions, st?.pendingSubmissions ? COLORS.danger : COLORS.success, () => {
            activeTab.value = "pending";
          })
        ]),
        // Tab 切换
        h(el("el-radio-group"), {
          modelValue: activeTab.value,
          size: "small",
          "onUpdate:modelValue": (value) => {
            activeTab.value = value;
          }
        }, () => [
          h(el("el-radio-button"), { value: "bottles" }, () => "瓶子管理"),
          h(el("el-radio-button"), { value: "pending" }, () => "待审投稿" + (st?.pendingSubmissions ? "（" + st.pendingSubmissions + "）" : ""))
        ]),
        activeTab.value === "bottles" ? h("div", { style: "display:flex;flex-direction:column;gap:12px;flex:1;min-height:0" }, [
          // 筛选与搜索
          h("div", { style: "display:flex;gap:12px;align-items:center;flex-wrap:wrap" }, [
            h(el("el-radio-group"), {
              modelValue: query.filter,
              size: "small",
              "onUpdate:modelValue": onFilterChange
            }, () => [
              h(el("el-radio-button"), { value: "all" }, () => "全部"),
              h(el("el-radio-button"), { value: "reported" }, () => "被举报"),
              h(el("el-radio-button"), { value: "banned" }, () => "已封禁")
            ]),
            h(el("el-input"), {
              modelValue: searchInput.value,
              placeholder: "按瓶子 ID / 作者 ID 搜索",
              clearable: true,
              size: "small",
              style: "width:240px",
              "onUpdate:modelValue": (value) => {
                searchInput.value = value;
              },
              onKeydown: (event) => {
                if (event.key === "Enter") applySearch();
              },
              onClear: applySearch
            }),
            h(el("el-button"), { size: "small", type: "primary", plain: true, onClick: applySearch }, () => "搜索")
          ]),
          // 列表 + 详情两栏（窄屏自动纵向堆叠）
          h("div", { style: "display:flex;gap:12px;align-items:flex-start;flex:1;min-height:0;flex-wrap:wrap" }, [
            renderListPane(),
            renderDetailPane()
          ])
        ]) : h("div", { style: "display:flex;flex-direction:column;gap:12px;flex:1;min-height:0" }, [
          h(
            "div",
            { style: "font-size:12px;color:#909399" },
            "自动内容安全审核不可用时，用户投稿需在此通过预审后才会入海。"
          ),
          // 待审列表 + 待审详情两栏（与瓶子管理结构对称）
          h("div", { style: "display:flex;gap:12px;align-items:flex-start;flex:1;min-height:0;flex-wrap:wrap" }, [
            renderPendingListPane(),
            renderPendingDetailPane()
          ])
        ])
      ]));
    };
  }
});

// client/index.ts
var client_default = (ctx) => {
  ctx.page({
    path: "/driftbottle",
    name: "漂流瓶管理",
    order: 5,
    fields: [],
    component: app_default
  });
};
export {
  client_default as default
};
