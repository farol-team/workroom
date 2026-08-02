namespace :record do
  desc "Re-read a room's journal and prove the chain from the bytes — record:verify[slug], or every room"
  task :verify, [ :slug ] => :environment do |_task, args|
    rooms = args[:slug] ? [ Channel.find_by!(slug: args[:slug]) ] : Channel.order(:slug).to_a
    broken = []

    rooms.each do |room|
      result = RecordStore::Verify.call(room)
      if result.ok?
        puts "#{room.slug}: OK (#{result.entries} entries)"
      else
        broken << room.slug
        result.failures.each { |failure| puts "#{room.slug}: #{failure}" }
      end
    end

    # Nonzero, because this is a check and a check nobody can wire into
    # anything is a report. `abort` prints to stderr and leaves the lines above
    # on stdout, so a pipe keeps the findings and the shell keeps the verdict.
    abort "the record does not verify: #{broken.join(", ")}" if broken.any?
  end
end
