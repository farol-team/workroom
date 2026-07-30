# A room with something already in it, so the concept is testable in one step.
alice = User.find_or_create_by!(email: "alice@farol.run") { |u|
  u.name = "Alice"; u.provider = "dev"; u.uid = "alice@farol.run"; u.api_token = "dev-alice"
}
bob = User.find_or_create_by!(email: "bob@farol.run") { |u|
  u.name = "Bob"; u.provider = "dev"; u.uid = "bob@farol.run"; u.api_token = "dev-bob"
}

meetings = Channel.find_or_create_by!(slug: "meetings") { |c|
  c.name = "Meetings"; c.purpose = "Client conversations and what came out of them"
}
Channel.find_or_create_by!(slug: "marketing") { |c|
  c.name = "Marketing"; c.purpose = "Positioning, campaigns, and what has been tried"
}

[ alice, bob ].each do |u|
  Channel.find_each { |c| c.memberships.find_or_create_by!(user: u) }
end

if meetings.memory_entries.none?
  store = Memory::Store.current
  store.write(meetings,
    title: "Acme wants monthly reporting, not weekly",
    detail: "Acme's ops lead asked for monthly rollups. Weekly was creating noise " \
            "for their team and nobody read it. Agreed on the first Tuesday of each month.",
    trust: "human", author: alice, key: "acme-reporting-cadence")
  store.write(meetings,
    title: "Pricing objections cluster around onboarding effort",
    detail: "Across four calls the objection was not the price itself but the " \
            "perceived setup cost. Prospects assume a multi-week rollout.",
    trust: "agent", key: "pricing-objection-pattern")
end

puts "Seeded: #{User.count} users, #{Channel.count} channels, #{MemoryEntry.count} memory entries"
puts "Tokens: alice=dev-alice bob=dev-bob"
