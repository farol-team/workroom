# A room with work already in it, so a fresh install has something worth looking
# at rather than an empty channel and a blinking cursor.

alice = User.find_or_create_by!(email: "alice@farol.run") { |u|
  u.name = "Alice"; u.provider = "dev"; u.uid = "alice@farol.run"; u.api_token = "dev-alice"
}
bob = User.find_or_create_by!(email: "bob@farol.run") { |u|
  u.name = "Bob"; u.provider = "dev"; u.uid = "bob@farol.run"; u.api_token = "dev-bob"
}

meetings = Channel.find_or_create_by!(slug: "meetings") { |c|
  c.name = "Meetings"; c.purpose = "Client conversations and what came out of them"
}
marketing = Channel.find_or_create_by!(slug: "marketing") { |c|
  c.name = "Marketing"; c.purpose = "Positioning, campaigns, and what has been tried"
}

[ alice, bob ].each { |u| Channel.find_each { |c| c.memberships.find_or_create_by!(user: u) } }

store = Memory::Store.current

if meetings.memory_entries.none?
  store.write(meetings,
    title: "Acme wants monthly reporting, not weekly",
    detail: "Acme's ops lead asked for monthly rollups. Weekly created noise for their " \
            "team and nobody read it. Agreed on the first Tuesday of each month.",
    trust: "human", author: alice, key: "acme-reporting-cadence")
  store.write(meetings,
    title: "Pricing objections cluster around onboarding effort",
    detail: "Across four calls the objection was not the price but the perceived setup " \
            "cost. Prospects assume a multi-week rollout.",
    trust: "agent", key: "pricing-objection-pattern")
end

if marketing.memory_entries.none?
  store.write(marketing,
    title: "The setup-cost objection is a positioning problem",
    detail: "If four sales calls raise onboarding effort unprompted, the site is not " \
            "answering it. Worth a page rather than a rebuttal.",
    trust: "agent", key: "setup-cost-positioning")
end

# A finished turn, so the channel shows what one looks like before you run yours.
if meetings.messages.none?
  question = meetings.messages.create!(
    author: alice, body: "@agent what did we agree with Acme about reporting?")

  session = AgentSession.create!(user: alice, channel: meetings, agent_kind: "opencode",
                                 external_id: "ses_seed", status: "idle")
  run = session.agent_runs.create!(
    trigger_message: question, status: "succeeded", model: "opencode/big-pickle",
    context_used: 18_400, context_size: 200_000, cost: 0.03,
    started_at: 3.minutes.ago, ended_at: 2.minutes.ago)

  run.run_steps.create!(kind: "plan", payload: { entries: [
    { "content" => "Search what the room knows about Acme", "status" => "completed" },
    { "content" => "Answer from it", "status" => "completed" }
  ] })
  run.run_steps.create!(kind: "tool_use", label: "search_capabilities: Acme reporting")
  run.run_steps.create!(kind: "tool_result", label: "1 entry")

  meetings.messages.create!(author: run, parent: question,
    body: "Monthly rollups, first Tuesday of the month. Weekly was creating noise for " \
          "their team and nobody was reading it.")
end

puts "Seeded #{User.count} people, #{Channel.count} channels, " \
     "#{MemoryEntry.current.count} memories, #{Message.count} messages."
puts
puts "  Sign in as  alice@farol.run  or  bob@farol.run"
puts "  API tokens  dev-alice / dev-bob"
