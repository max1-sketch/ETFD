local MessagingService = game:GetService("MessagingService")
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local BanDataStore = DataStoreService:GetDataStore("WebBanList_v3")

local WEB_SERVER_URL = "http://localhost:3000/api/roblox/players" 
local SERVER_SECRET = "ETFD23"

local activeToolBans = {}

local warnRemote = ReplicatedStorage:FindFirstChild("WarnRemote")
if not warnRemote then
	warnRemote = Instance.new("RemoteEvent")
	warnRemote.Name = "WarnRemote"
	warnRemote.Parent = ReplicatedStorage
end

local function getPlayerTools(player)
	local tools = {}
	if player:FindFirstChild("Backpack") then
		for _, tool in ipairs(player.Backpack:GetChildren()) do
			if tool:IsA("Tool") then table.insert(tools, tool.Name) end
		end
	end
	if player.Character then
		for _, tool in ipairs(player.Character:GetChildren()) do
			if tool:IsA("Tool") then table.insert(tools, tool.Name .. " (Equipped)") end
		end
	end
	return tools
end

local function monitorToolBans(player)
	local function checkTool(child)
		if child:IsA("Tool") then
			local key = player.UserId .. "_" .. child.Name
			if activeToolBans[key] and os.time() < activeToolBans[key] then
				task.defer(function() child:Destroy() end)
				warnRemote:FireClient(player, "The tool '" .. child.Name .. "' is currently banned for you!")
			end
		end
	end

	player.ChildAdded:Connect(checkTool)
	if player:FindFirstChild("Backpack") then
		player.Backpack.ChildAdded:Connect(checkTool)
	end
	player.CharacterAdded:Connect(function(char)
		char.ChildAdded:Connect(checkTool)
	end)
end

Players.PlayerAdded:Connect(function(player)
	monitorToolBans(player)

	local globalUnbanTime = 0
	pcall(function()
		globalUnbanTime = BanDataStore:GetAsync("GLOBAL_UNBAN_TIMESTAMP") or 0
	end)

	local success, banData = pcall(function()
		return BanDataStore:GetAsync(tostring(player.UserId))
	end)

	if success and banData and type(banData) == "table" then
		if banData.bannedAt and banData.bannedAt <= globalUnbanTime then
			pcall(function() BanDataStore:RemoveAsync(tostring(player.UserId)) end)
			return
		end

		if banData.bannedUntil and banData.bannedUntil ~= "PERMANENT" and os.time() >= banData.bannedUntil then
			pcall(function() BanDataStore:RemoveAsync(tostring(player.UserId)) end)
			return
		end

		local timeText = banData.bannedUntil == "PERMANENT" and "Permanent" or os.date("%X %Y-%m-%d", banData.bannedUntil)
		player:Kick("\n[BANNED]\nReason: " .. (banData.reason or "Banned by Admin") .. "\nExpires: " .. timeText)
	end
end)

task.spawn(function()
	while task.wait(3) do
		local playerList = {}
		for _, p in ipairs(Players:GetPlayers()) do
			table.insert(playerList, {
				userId = p.UserId,
				username = p.Name,
				displayName = p.DisplayName,
				tools = getPlayerTools(p)
			})
		end

		pcall(function()
			HttpService:RequestAsync({
				Url = WEB_SERVER_URL,
				Method = "POST",
				Headers = {
					["Content-Type"] = "application/json",
					["x-server-secret"] = SERVER_SECRET
				},
				Body = HttpService:JSONEncode({ players = playerList })
			})
		end)
	end
end)

MessagingService:SubscribeAsync("ModChannel", function(message)
	local decodeSuccess, data = pcall(function()
		return HttpService:JSONDecode(message.Data)
	end)

	if not decodeSuccess or not data then return end

	local userId = tonumber(data.userId)
	local action = data.action
	local reason = data.reason or "No reason provided."
	local toolName = data.toolName
	local durationSeconds = tonumber(data.durationSeconds) or 0

	if action == "BAN" then
		local bannedUntil = (durationSeconds > 0) and (os.time() + durationSeconds) or "PERMANENT"
		pcall(function()
			BanDataStore:SetAsync(tostring(userId), {
				bannedAt = os.time(),
				bannedUntil = bannedUntil,
				reason = reason
			})
		end)

		local targetPlayer = Players:GetPlayerByUserId(userId)
		if targetPlayer then targetPlayer:Kick("\n[BANNED]\nReason: " .. reason) end

	elseif action == "UNBAN" then
		pcall(function() BanDataStore:RemoveAsync(tostring(userId)) end)

	elseif action == "UNBAN_ALL" then
		pcall(function() BanDataStore:SetAsync("GLOBAL_UNBAN_TIMESTAMP", os.time()) end)

	elseif action == "KICK" then
		local targetPlayer = Players:GetPlayerByUserId(userId)
		if targetPlayer then targetPlayer:Kick("\n[KICKED]\nReason: " .. reason) end

	elseif action == "WARN" then
		local targetPlayer = Players:GetPlayerByUserId(userId)
		if targetPlayer then warnRemote:FireClient(targetPlayer, reason) end

	elseif action == "REMOVE_TOOL" then
		local targetPlayer = Players:GetPlayerByUserId(userId)
		if targetPlayer then
			local cleanName = toolName:gsub(" %((%w+)%)", "")
			if targetPlayer.Backpack:FindFirstChild(cleanName) then targetPlayer.Backpack[cleanName]:Destroy() end
			if targetPlayer.Character and targetPlayer.Character:FindFirstChild(cleanName) then targetPlayer.Character[cleanName]:Destroy() end
		end

	elseif action == "BAN_TOOL" then
		local targetPlayer = Players:GetPlayerByUserId(userId)
		local key = userId .. "_" .. toolName
		activeToolBans[key] = os.time() + durationSeconds

		if targetPlayer then
			if targetPlayer.Backpack:FindFirstChild(toolName) then targetPlayer.Backpack[toolName]:Destroy() end
			if targetPlayer.Character and targetPlayer.Character:FindFirstChild(toolName) then targetPlayer.Character[toolName]:Destroy() end
			warnRemote:FireClient(targetPlayer, "Your access to tool '" .. toolName .. "' has been suspended.")
		end
	end
end)