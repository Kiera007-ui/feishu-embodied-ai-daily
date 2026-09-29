You are preparing the Chinese-language embodied AI daily brief for {{DATE}} (Asia/Shanghai).
Search the web broadly, read the full body of each candidate article, and return only a JSON object:
{"new_items":[{"event_key":"...","title":"...","summary":"...","source":"...","url":"https://...","published_at":"YYYY-MM-DDTHH:mm:ss+08:00","first_disclosed_at":"YYYY-MM-DDTHH:mm:ss+08:00","evidence_quote":"..."}]}

The ordinary news window is {{WINDOW_START}} inclusive through {{WINDOW_END}} exclusive. Both article publication and the core event's first public disclosure must be in this window. Reposts, recycled research reports, and old events described in a new article fail the gate. Do not fabricate dates or infer an exact time from a date-only source. Exclude any candidate whose times cannot be verified.

Search beyond titles: read article bodies to identify central companies and events even when the company is absent from the headline. Discover candidates across 机器之心、新智元、量子位、AI前线/InfoQ、极客公园、36氪/硬氪、投资界、甲子光年、晚点、硅星人、你好太空, robotics specialist media, company releases, and primary filings. Group duplicate coverage by event. Original reporting and independent confirmation improve priority. Ordinary hand products, routine demos, common product announcements, and financing without material significance have low priority. Dexterous hands receive no fixed bonus. Exclude pure academic papers, unrelated robotics, and Sina/NetEase as final sources.

Prioritize significant embodied-robotics deployments, new system capabilities, credible commercialization, and material company or industry changes. Only include facts supported by sources. Each summary must be 100-220 Chinese characters. Give a directly opened article or primary-document URL. evidence_quote must be a short literal excerpt from that URL supporting the central fact. Dates and quotes must be visible on the page. Do not put markdown fences or commentary around the JSON.

{{CARRYOVER_NOTE}}

Return at most {{NEW_LIMIT}} truly new items. If too few qualified new items exist, return fewer; never pad with stale material.
