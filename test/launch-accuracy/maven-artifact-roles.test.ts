import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePomContract, diffPomContracts } from '../../dist/evidence/surface/maven-pom.js';

/**
 * `org.springframework.boot:spring-boot-starter-parent` publishes no JAR and
 * never has: it is `<packaging>pom</packaging>`, a parent whose whole purpose
 * is the dependency and plugin management it hands down. Asking Maven Central
 * for its JAR and reporting the 404 said Drift looked for the wrong artifact,
 * not that the package could not be inspected.
 */

const SPRING_BOOT_PARENT = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-dependencies</artifactId>
    <version>3.2.0</version>
  </parent>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>3.2.0</version>
  <packaging>pom</packaging>
  <properties>
    <java.version>17</java.version>
    <resource.delimiter>@</resource.delimiter>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework</groupId>
        <artifactId>spring-core</artifactId>
        <version>6.1.1</version>
      </dependency>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>legacy</artifactId>
        <version>1.0.0</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <build>
    <pluginManagement>
      <plugins>
        <plugin>
          <artifactId>maven-jar-plugin</artifactId>
          <version>3.3.0</version>
        </plugin>
      </plugins>
    </pluginManagement>
  </build>
</project>`;

describe('Maven packaging is classified before a JAR is expected', () => {
  test('a parent POM is read as a POM, not as a missing JAR', () => {
    const contract = parsePomContract(SPRING_BOOT_PARENT);

    assert.equal(contract.packaging, 'pom');
    assert.equal(contract.role, 'pom');
    assert.equal(contract.managedDependencies.get('org.springframework:spring-core'), '6.1.1');
    assert.equal(contract.managedPlugins.get('org.apache.maven.plugins:maven-jar-plugin'), '3.3.0');
    assert.equal(contract.properties.get('java.version'), '17');
  });

  test('an ordinary artifact still goes to the classfile differ', () => {
    for (const [packaging, role] of [
      ['jar', 'jar'],
      ['bundle', 'jar'],
      ['maven-plugin', 'jar'],
      ['war', 'other'],
      ['aar', 'other'],
    ] as const) {
      const contract = parsePomContract(`<project><packaging>${packaging}</packaging></project>`);
      assert.equal(contract.role, role, packaging);
    }
    // Maven's default when the element is absent.
    assert.equal(parsePomContract('<project><artifactId>x</artifactId></project>').role, 'jar');
  });

  test('the POM contract diff reports only what it can prove', () => {
    const before = parsePomContract(SPRING_BOOT_PARENT);
    const after = parsePomContract(
      SPRING_BOOT_PARENT.replace(
        /<dependency>\s*<groupId>com\.example<\/groupId>[\s\S]*?<\/dependency>/,
        '',
      )
        .replace('<resource.delimiter>@</resource.delimiter>', '')
        .replace('<version>6.1.1</version>', '<version>6.2.0</version>'),
    );

    const changes = diffPomContracts(before, after);
    const symbols = changes.map((change) => change.symbol).sort();

    assert.deepEqual(symbols, ['${resource.delimiter}', 'com.example:legacy']);
    // A managed version moving forward is ordinary maintenance, not a break.
    assert.equal(changes.some((change) => change.symbol === 'org.springframework:spring-core'), false);
  });
});
